"""Back up the delivery production database and its Supabase file Storage."""

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote
from uuid import uuid4

import boto3
import psycopg2
from botocore.config import Config

PROJECT = "jabapvnmfdflysxfxwwf"
CHUNK_SIZE = 1024 * 1024
SUPABASE_CA = Path(__file__).with_name("supabase-prod-ca.crt").resolve()


class BackupError(Exception):
    pass


def setting(name, pattern=None):
    value = os.environ.get(name, "")
    if not value or (pattern and not re.fullmatch(pattern, value)):
        raise BackupError(f"Missing or invalid setting: {name}")
    return value


def database_connection():
    value = setting("SUPABASE_DB_URL").strip()
    # Parse the part containing the password separately. URL parsers otherwise
    # treat characters such as brackets and unescaped @ signs as URI syntax.
    uri = re.fullmatch(
        r"(?:postgresql|postgres)://([^:]+):(.+)@([a-z0-9.-]+)(?::5432)?/postgres"
        r"(?:[?]sslmode=(?:require|verify-ca|verify-full))?",
        value,
    )
    if not uri:
        raise BackupError("The database secret must be the production PostgreSQL connection URI.")

    username, encoded_password, host = uri.groups()
    if encoded_password == "[YOUR-DATABASE-PASSWORD]":
        raise BackupError("The production database secret still contains the Supabase password placeholder.")
    username = unquote(username)
    direct = host == f"db.{PROJECT}.supabase.co" and username == "postgres"
    pooler = host.endswith(".pooler.supabase.com") and username == f"postgres.{PROJECT}"
    if not (direct or pooler):
        raise BackupError("Use the production direct or session pooler database URL.")
    bracketed = encoded_password.startswith("[") and encoded_password.endswith("]")
    return host, username, unquote(encoded_password), bracketed


def run_client(command, env=None):
    result = subprocess.run(command, env=env, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise BackupError(f"{command[0]} failed with exit code {result.returncode}.")


def s3_client(endpoint, region, key_prefix):
    return boto3.client(
        "s3", endpoint_url=endpoint, region_name=region,
        aws_access_key_id=setting(f"{key_prefix}_KEY_ID"),
        aws_secret_access_key=setting(f"{key_prefix}_KEY"),
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"},
                      retries={"mode": "standard", "max_attempts": 5}),
    )


def inventory(cursor):
    cursor.execute("select id, type::text from storage.buckets order by id")
    buckets = cursor.fetchall()
    if any(kind != "STANDARD" for _, kind in buckets):
        raise BackupError("The project has a non-file Storage bucket that requires its own export.")

    cursor.execute("""
        select bucket_id, name, version, updated_at, metadata->>'eTag', metadata->>'size'
        from storage.objects order by bucket_id, name
    """)
    return buckets, cursor.fetchall()


def hash_stream(source, target=None):
    checksum = hashlib.sha256()
    size = 0
    while chunk := source.read(CHUNK_SIZE):
        if target is not None:
            target.write(chunk)
        checksum.update(chunk)
        size += len(chunk)
    return size, checksum.hexdigest()


def copy_storage(path, inventory_rows):
    if not inventory_rows:
        return
    source = s3_client(
        f"https://{PROJECT}.storage.supabase.co/storage/v1/s3",
        setting("SUPABASE_STORAGE_REGION", r"[a-z0-9-]+"), "SUPABASE_STORAGE",
    )
    (path / "objects").mkdir()
    with (path / "storage.jsonl").open("w", encoding="utf-8") as manifest:
        for index, (bucket, key, _, _, etag, expected_size) in enumerate(inventory_rows):
            options = {"IfMatch": '"' + etag.strip('"') + '"'} if etag else {}
            item = source.get_object(Bucket=bucket, Key=key, **options)
            archive_path = f"objects/{index:012d}"
            with closing(item["Body"]) as body, (path / archive_path).open("wb") as output:
                size, digest = hash_stream(body, output)
            if size != item["ContentLength"] or (
                expected_size is not None and size != int(expected_size)
            ):
                raise BackupError("A Storage object did not match its expected size.")
            record = {
                "bucket": bucket, "key": key, "path": archive_path, "size": size,
                "sha256": digest, "content_type": item.get("ContentType"),
                "cache_control": item.get("CacheControl"), "metadata": item.get("Metadata", {}),
            }
            manifest.write(json.dumps(record, ensure_ascii=False) + "\n")


def connect_database(params, bracketed=False):
    try:
        return psycopg2.connect(**params)
    except psycopg2.OperationalError as error:
        message = str(error).lower()
        rejected = any(term in message for term in (
            "password authentication failed", "sasl authentication failed",
            "wrong password", "invalid password",
        ))
        if rejected and bracketed:
            # The dashboard template puts brackets around the placeholder.
            # Retry without those brackets only after authentication failed.
            params["password"] = params["password"][1:-1]
            return connect_database(params)
        if rejected:
            raise BackupError("Supabase rejected the PostgreSQL password.") from None
        if "tenant or user not found" in message:
            raise BackupError("Supabase did not recognize the PostgreSQL pooler user.") from None
        if "certificate" in message or "ssl" in message:
            raise BackupError("Could not verify the Supabase PostgreSQL TLS connection.") from None
        if "timeout" in message or "could not translate host" in message:
            raise BackupError("Could not reach the Supabase PostgreSQL host.") from None
        raise BackupError("PostgreSQL refused the Supabase connection.") from None


def export(path, database, started):
    host, username, password, bracketed = database
    params = {
        "host": host,
        "port": "5432",
        "dbname": "postgres",
        "user": username,
        "password": password,
        "sslmode": "verify-full",
        "sslrootcert": str(SUPABASE_CA),
        "connect_timeout": "30",
    }
    connection = connect_database(params, bracketed)
    env = dict(os.environ, PGHOST=params["host"], PGPORT=params["port"],
               PGDATABASE=params["dbname"], PGUSER=params["user"], PGPASSWORD=params["password"],
               PGSSLMODE=params["sslmode"], PGSSLROOTCERT=params["sslrootcert"],
               PGCONNECT_TIMEOUT=params["connect_timeout"])
    with closing(connection):
        connection.set_session(isolation_level="REPEATABLE READ", readonly=True)
        with connection.cursor() as cursor:
            cursor.execute("select pg_export_snapshot()")
            snapshot, = cursor.fetchone()
            before = inventory(cursor)
            run_client(["pg_dump", "--format=custom", f"--snapshot={snapshot}",
                        f"--file={path / 'database.dump'}", "--lock-wait-timeout=30s"], env)
        connection.rollback()

    run_client(["pg_dumpall", "--roles-only", "--no-role-passwords",
                f"--file={path / 'roles.sql'}"], env)
    run_client(["pg_restore", "--file=/dev/null", str(path / "database.dump")])
    buckets, objects = before
    (path / "storage.jsonl").touch()
    copy_storage(path, objects)
    # Reject a backup if file Storage changed while it was being exported.
    with closing(connect_database(params)) as connection, connection.cursor() as cursor:
        connection.set_session(isolation_level="REPEATABLE READ", readonly=True)
        if inventory(cursor) != before:
            raise BackupError("Storage changed during export. Run the backup again.")

    (path / "manifest.json").write_text(json.dumps({
        "format": 1, "project": PROJECT, "started_at": started.isoformat(),
        "storage_buckets": [bucket for bucket, _ in buckets], "storage_object_count": len(objects),
    }, indent=2) + "\n", encoding="utf-8")
    return len(buckets), len(objects)


def backup(export_root=None):
    database = database_connection()
    recipient = setting("BACKUP_AGE_RECIPIENT", r"age1[023456789acdefghjklmnpqrstuvwxyz]{58}")
    region = setting("B2_REGION", r"[a-z]{2}-[a-z]+-[0-9]{3}")
    bucket = setting("B2_BUCKET", r"[A-Za-z0-9][A-Za-z0-9-]{5,62}")
    target = s3_client(f"https://s3.{region}.backblazeb2.com", region, "B2")
    acl = target.get_bucket_acl(Bucket=bucket)
    owner_id = acl["Owner"]["ID"]
    if any(grant["Grantee"].get("ID") != owner_id for grant in acl["Grants"]):
        raise BackupError("The Backblaze B2 destination must be private.")

    started = datetime.now(timezone.utc)
    key = f"delivery-production/{started:%Y/%m/%d/%Y%m%dT%H%M%SZ}-{uuid4().hex}.tar.gz.age"
    with tempfile.TemporaryDirectory(prefix="delivery-backup-") as temp:
        root = Path(temp)
        export_path = Path(export_root) if export_root else root / "export"
        export_path.mkdir(mode=0o700)
        buckets, objects = export(export_path, database, started)
        encrypted = root / "backup.tar.gz.age"
        with subprocess.Popen(["tar", "-czf", "-", "-C", str(export_path), "."],
                              stdout=subprocess.PIPE) as archive:
            try:
                result = subprocess.run(["age", "--encrypt", "-r", recipient,
                                         "-o", str(encrypted)], stdin=archive.stdout, check=False)
            finally:
                archive.stdout.close()
            if archive.wait() or result.returncode:
                raise BackupError("Could not create the encrypted archive.")

        with encrypted.open("rb") as content:
            expected = hash_stream(content)
        target.upload_file(str(encrypted), bucket, key)
        with closing(target.get_object(Bucket=bucket, Key=key)["Body"]) as remote:
            if hash_stream(remote) != expected:
                raise BackupError("The downloaded B2 file failed SHA-256 verification.")
        target.put_object(
            Bucket=bucket, Key=f"{key}.verified.json", ContentType="application/json",
            Body=json.dumps({"size": expected[0], "sha256": expected[1]}).encode("utf-8"),
        )

    print(f"Verified backup ({expected[0]} bytes, {buckets} buckets, {objects} files).")
    return {"object_key": key, "size_bytes": expected[0], "sha256": expected[1], "created_at": started.isoformat(), "metadata": {"buckets": buckets, "files": objects}}


if __name__ == "__main__":
    try:
        backup()
    except BackupError as error:
        sys.exit(str(error))
    except Exception as error:
        # SDK and database errors can include private filenames or connection details.
        sys.exit(f"Backup failed: {type(error).__name__}")
