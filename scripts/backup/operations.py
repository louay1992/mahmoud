"""Owner-authorized durable operations. Credentials never cross the server/client boundary."""
import base64
import io
import json
import os
import re
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from contextlib import closing, contextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from uuid import uuid4

import psycopg2
from botocore.exceptions import ClientError
from psycopg2 import sql
from psycopg2.extras import Json, RealDictCursor
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
import backup as bk

KEY = re.compile(r"delivery-production/(\d{4})/(\d{2})/(\d{2})/(\d{8}T\d{6}Z)-[a-f0-9]{32}\.tar\.gz\.age\Z")
PRESERVE = {'subscription_owners', 'project_subscription', 'subscription_changes', 'subscription_admin_invites', 'push_config'}
BUSINESS = {'admins','captains','captain_payments','carriers','carrier_payments','customers','marketers','marketer_payments','notifications','orders','order_items','order_events','order_item_capital','price_requests','products','settings','shipment_events','stock','stock_invoices','stock_invoice_items','stock_movements','warehouses'}
EPHEMERAL = {'native_push_devices', 'native_push_preferences', 'push_subscriptions', 'op_guard'}


def connection():
    host, user, password, bracketed = bk.database_connection()
    return bk.connect_database(dict(host=host, user=user, password=password, dbname='postgres', port=5432,
        sslmode='verify-full', sslrootcert=str(bk.SUPABASE_CA), connect_timeout=30), bracketed)


def b2():
    region = bk.setting('B2_REGION', r'[a-z]{2}-[a-z]+-[0-9]{3}')
    return bk.s3_client(f'https://s3.{region}.backblazeb2.com', region, 'B2'), bk.setting('B2_BUCKET')


def storage():
    return bk.s3_client(f'https://{bk.PROJECT}.storage.supabase.co/storage/v1/s3', bk.setting('SUPABASE_STORAGE_REGION'), 'SUPABASE_STORAGE')


def transport_secret(password, salt):
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=b'mahmoud-owner-recovery-transport-v1').derive((password or '').encode())


def ensure_transport(db):
    with db.cursor() as cur:
        cur.execute('select encrypted_private_key,salt,nonce from owner_private.backup_keys order by created_at desc limit 1')
        current = cur.fetchone()
        if current:
            try:
                AESGCM(transport_secret(db.info.password,bytes(current[1]))).decrypt(bytes(current[2]),bytes(current[0]),bk.PROJECT.encode())
                return
            except Exception:
                pass
        key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        public = key.public_key().public_numbers()
        enc = lambda n: base64.urlsafe_b64encode(n.to_bytes((n.bit_length()+7)//8, 'big')).decode().rstrip('=')
        jwk = {'kty': 'RSA', 'n': enc(public.n), 'e': enc(public.e), 'alg': 'RSA-OAEP-256', 'ext': True, 'key_ops': ['encrypt']}
        salt, nonce = os.urandom(32), os.urandom(12)
        private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        encrypted = AESGCM(transport_secret(db.info.password, salt)).encrypt(nonce, private, bk.PROJECT.encode())
        cur.execute('insert into owner_private.backup_keys(public_jwk,encrypted_private_key,salt,nonce)values(%s,%s,%s,%s)', (Json(jwk), encrypted, salt, nonce))
    db.commit()


def decrypt_identity(db, job):
    with db.cursor() as cur:
        cur.execute('select encrypted_private_key,salt,nonce from owner_private.backup_keys where id=%s', (job['transport_key_id'],))
        encrypted, salt, nonce = cur.fetchone()
    try:
        pem = AESGCM(transport_secret(db.info.password, bytes(salt))).decrypt(bytes(nonce), bytes(encrypted), bk.PROJECT.encode())
        private = serialization.load_pem_private_key(pem, password=None)
        identity = private.decrypt(base64.b64decode(job['encrypted_identity'], validate=True), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None)).decode().strip()
        if not re.fullmatch(r'AGE-SECRET-KEY-1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]{58}', identity):
            raise ValueError()
        return identity
    except Exception:
        raise bk.BackupError('RECOVERY_KEY_INVALID') from None


def sync_catalog(db):
    client, bucket = b2()
    seen = []
    for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix='delivery-production/'):
        for item in page.get('Contents', []):
            key = item['Key']; match = KEY.fullmatch(key)
            if not match:
                continue
            verified = False; checksum = None
            try:
                side = client.get_object(Bucket=bucket, Key=key+'.verified.json')
                with closing(side['Body']) as body:
                    meta = json.loads(body.read(4097))
                checksum = meta.get('sha256')
                verified = meta.get('size') == item['Size'] and isinstance(checksum,str) and bool(re.fullmatch('[a-f0-9]{64}', checksum))
            except (ValueError,AttributeError,TypeError):
                verified=False;checksum=None
            except client.exceptions.NoSuchKey:
                pass
            created = datetime.strptime(match[4], '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
            with db.cursor() as cur:
                cur.execute('''insert into owner_private.backup_catalog(object_key,created_at,size_bytes,sha256,verified,last_seen_at)
                    values(%s,%s,%s,%s,%s,now()) on conflict(object_key) do update set size_bytes=excluded.size_bytes,
                    sha256=excluded.sha256,verified=excluded.verified,last_seen_at=now()''', (key, created, item['Size'], checksum, verified))
            seen.append(key)
    with db.cursor() as cur:
        # Historical jobs retain their FK/audit, but missing remote files can no longer be selected.
        cur.execute('update owner_private.backup_catalog set verified=false where not(object_key=any(%s::text[]))', (seen,))
    db.commit()
    return {'files': len(seen)}


def verified_download(db, key, output):
    if not KEY.fullmatch(key):
        raise bk.BackupError('BACKUP_INVALID')
    with db.cursor() as cur:
        cur.execute('select size_bytes,sha256 from owner_private.backup_catalog where object_key=%s and verified', (key,))
        expected = cur.fetchone()
    if not expected:
        raise bk.BackupError('BACKUP_UNVERIFIED')
    client, bucket = b2()
    with closing(client.get_object(Bucket=bucket, Key=key)['Body']) as body, output.open('wb') as target:
        actual = bk.hash_stream(body, target)
    if actual != expected:
        raise bk.BackupError('BACKUP_CHECKSUM')


def extract_verified(archive, destination):
    destination.mkdir(mode=0o700)
    with tarfile.open(archive, 'r:gz') as source:
        names = set()
        for member in source:
            normalized = member.name.removeprefix('./')
            if normalized in ('', '.') and member.isdir():
                continue
            if member.isdir() and normalized.rstrip('/') == 'objects':
                continue
            if not member.isfile() or normalized in names or not (normalized in {'database.dump','roles.sql','manifest.json','storage.jsonl'} or re.fullmatch(r'objects/[0-9]{12}', normalized)):
                raise bk.BackupError('ARCHIVE_UNSAFE')
            names.add(normalized)
            target = destination / normalized
            target.parent.mkdir(mode=0o700, exist_ok=True)
            with closing(source.extractfile(member)) as content, target.open('wb') as output:
                bk.hash_stream(content, output)
    manifest = json.loads((destination/'manifest.json').read_text())
    if manifest.get('format') != 1 or manifest.get('project') != bk.PROJECT:
        raise bk.BackupError('BACKUP_PROJECT_MISMATCH')
    entries = []; seen = set(); paths = set()
    for line in (destination/'storage.jsonl').read_text().splitlines():
        entry = json.loads(line); path = entry.get('path', '')
        pair = (entry.get('bucket'), entry.get('key'))
        if not re.fullmatch(r'objects/[0-9]{12}', path) or path in paths or pair in seen or pair[0] not in manifest['storage_buckets'] or not isinstance(pair[1], str) or not pair[1]:
            raise bk.BackupError('STORAGE_MANIFEST_INVALID')
        seen.add(pair); paths.add(path)
        with (destination/path).open('rb') as content:
            if bk.hash_stream(content) != (entry['size'], entry['sha256']):
                raise bk.BackupError('STORAGE_CHECKSUM')
        entries.append(entry)
    if len(entries) != manifest.get('storage_object_count'):
        raise bk.BackupError('STORAGE_COUNT')
    return manifest, entries


@contextmanager
def staging_database(root):
    """Private local PostgreSQL; restore only parsed COPY data, never backup SQL functions/DDL."""
    data = root/'pg'; sockets = root/'sockets'; sockets.mkdir(mode=0o700)
    bk.run_client(['initdb', '-D', str(data), '-A', 'trust', '--no-locale', '-E', 'UTF8'])
    bk.run_client(['pg_ctl', '-D', str(data), '-l', str(root/'pg.log'), '-o', f"-k {sockets} -h ''", '-w', 'start'])
    try:
        with closing(psycopg2.connect(host=str(sockets), dbname='postgres', user=os.environ['USER'])) as db:
            yield db
    finally:
        bk.run_client(['pg_ctl', '-D', str(data), '-m', 'immediate', '-w', 'stop'])


def prepare_data(production, stage, root, dump):
    """Stage against current column names using TEXT: PostgreSQL COPY handles every data type losslessly."""
    with production.cursor() as cur:
        cur.execute("select tablename from pg_tables where schemaname='public' order by tablename")
        tables = {row[0] for row in cur.fetchall()}
        if tables != BUSINESS | PRESERVE | EPHEMERAL:
            raise bk.BackupError('SCHEMA_INCOMPATIBLE')
        business = sorted(BUSINESS)
        cur.execute('select o.user_id::text,lower(u.email) from public.subscription_owners o join auth.users u on u.id=o.user_id')
        owners = cur.fetchall()
        if not owners:
            raise bk.BackupError('OWNER_MISSING')
        cur.execute("select table_schema,table_name,column_name,is_generated from information_schema.columns where table_schema in ('public','auth') order by ordinal_position")
        columns = {}
        for schema, table, column, generated in cur.fetchall():
            if generated == 'NEVER':
                columns.setdefault((schema, table), []).append(column)
    allowed = {('public', name) for name in business} | {('auth', 'users'), ('auth','identities')}
    with stage.cursor() as cur:
        cur.execute('create schema auth')
        for schema, table in sorted(allowed):
            defs = sql.SQL(',').join(sql.SQL('{} text').format(sql.Identifier(name)) for name in columns[(schema,table)])
            cur.execute(sql.SQL('create table {}.{}({})').format(sql.Identifier(schema), sql.Identifier(table), defs))
    stage.commit()
    data_sql = root/'data.sql'
    bk.run_client(['pg_restore', '--data-only', '--no-owner', '--no-privileges', '--schema=public', '--schema=auth', f'--file={data_sql}', str(dump)])
    copies = {}; copy_pattern = re.compile(r'^COPY ("?[a-z_][a-z0-9_]*"?)\.("?[a-z_][a-z0-9_]*"?) \((.+)\) FROM stdin;\s*$')
    with data_sql.open('r', encoding='utf-8', newline='') as source, stage.cursor() as cur:
        for line in source:
            match = copy_pattern.fullmatch(line)
            if not match:
                continue
            schema, table = match[1].strip('"'), match[2].strip('"')
            names = [name.strip().strip('"') for name in match[3].split(',')]
            selected = (schema,table) in allowed
            if selected and ((schema,table) in copies or any(name not in columns[(schema,table)] for name in names)):
                raise bk.BackupError('SCHEMA_INCOMPATIBLE')
            with tempfile.TemporaryFile(mode='w+', encoding='utf-8', newline='') as data:
                terminated = False
                for row in source:
                    if row.rstrip('\r\n') == r'\.':
                        terminated = True; break
                    if selected:
                        data.write(row)
                if not terminated:
                    raise bk.BackupError('DATABASE_COPY_INVALID')
                if selected:
                    data.seek(0)
                    statement = sql.SQL('copy {}.{} ({}) from stdin').format(sql.Identifier(schema), sql.Identifier(table), sql.SQL(',').join(map(sql.Identifier,names)))
                    cur.copy_expert(statement.as_string(stage), data)
                    copies[(schema,table)] = names
    if set(copies) != allowed:
        # Older snapshots lacking newly introduced business tables fail closed, before maintenance.
        raise bk.BackupError('SCHEMA_INCOMPATIBLE')
    stage.commit()
    # Never replace an owner's identity, email or administrator row with a historical version.
    ids, emails = [v[0] for v in owners], [v[1] for v in owners]
    with stage.cursor() as cur:
        cur.execute('delete from auth.identities where user_id=any(%s::text[])', (ids,))
        cur.execute('delete from auth.users where id=any(%s::text[])', (ids,))
        cur.execute('select count(*) from auth.users where lower(email)=any(%s::text[])', (emails,))
        if cur.fetchone()[0]:
            raise bk.BackupError('OWNER_IDENTITY_CONFLICT')
        cur.execute('delete from public.admins where lower(email)=any(%s::text[])', (emails,))
    stage.commit()
    return business, copies, ids, emails


def apply_data(production, stage, business, copies, owner_ids, owner_emails):
    with production.cursor() as cur:
        # Business triggers must not send notifications or recalculate historical totals on import.
        cur.execute("set local session_replication_role='replica'")
        for table in business + sorted(EPHEMERAL):
            cur.execute('select to_regclass(%s)', ('public.'+table,))
            if not cur.fetchone()[0]:
                continue
            if table == 'admins':
                cur.execute('delete from public.admins where not(lower(email)=any(%s::text[]))', (owner_emails,))
            else:
                cur.execute(sql.SQL('delete from public.{}').format(sql.Identifier(table)))
        # Normal Auth cascading deletes maintain provider-managed session/MFA tables and FK references.
        cur.execute("set local session_replication_role='origin'")
        cur.execute('delete from auth.users where not(id=any(%s::uuid[]))', (owner_ids,))
        cur.execute("set local session_replication_role='replica'")
        for schema, table in [('auth','users'), ('auth','identities')] + [('public', name) for name in business]:
            names = copies[(schema,table)]
            target = sql.SQL('{}.{} ({})').format(sql.Identifier(schema),sql.Identifier(table),sql.SQL(',').join(map(sql.Identifier,names)))
            with tempfile.TemporaryFile(mode='w+',encoding='utf-8',newline='') as content, stage.cursor() as source:
                source.copy_expert(sql.SQL('copy {} to stdout').format(target).as_string(stage),content)
                content.seek(0); cur.copy_expert(sql.SQL('copy {} from stdin').format(target).as_string(production),content)
        # Preserve terms/owner audit; historical invitations must never reactivate removed accounts.
        cur.execute('update public.subscription_admin_invites set approved_by=null,email_sent_at=null,auth_user_id=null where not(email=any(%s::text[]))',(owner_emails,))
        cur.execute("set local session_replication_role='origin'")
        # Validate all public/Auth FKs, including non-deferrable ones skipped during COPY.
        cur.execute("""select ns.nspname,c.relname,rns.nspname,r.relname,k.conkey,k.confkey,c.oid,r.oid,k.conname
            from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace ns on ns.oid=c.relnamespace
            join pg_class r on r.oid=k.confrelid join pg_namespace rns on rns.oid=r.relnamespace
            where k.contype='f' and ns.nspname in ('public','auth','owner_private','storage')""")
        constraints = cur.fetchall()
        for schema, table, refschema, reftable, keys, refs, oid, refoid, _ in constraints:
            def attnames(rel, nums):
                cur.execute('select attnum,attname from pg_attribute where attrelid=%s and attnum=any(%s)',(rel,nums))
                mapping = dict(cur.fetchall()); return [mapping[n] for n in nums]
            names, targets = attnames(oid,keys),attnames(refoid,refs)
            present = sql.SQL(' and ').join(sql.SQL('s.{} is not null').format(sql.Identifier(n)) for n in names)
            equal = sql.SQL(' and ').join(sql.SQL('s.{}=r.{}').format(sql.Identifier(a),sql.Identifier(b)) for a,b in zip(names,targets))
            query = sql.SQL('select exists(select 1 from {}.{} s where {} and not exists(select 1 from {}.{} r where {}))').format(sql.Identifier(schema),sql.Identifier(table),present,sql.Identifier(refschema),sql.Identifier(reftable),equal)
            cur.execute(query)
            if cur.fetchone()[0]:
                raise bk.BackupError('RESTORE_FOREIGN_KEY')
        for schema,table in copies:
            cur.execute("select a.attname,pg_get_serial_sequence(format('%%I.%%I',n.nspname,c.relname),a.attname) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=%s and c.relname=%s and a.attnum>0 and not a.attisdropped",(schema,table))
            for column,sequence in cur.fetchall():
                if sequence:
                    cur.execute(sql.SQL('select setval(%s,coalesce(max({}),1),max({}) is not null) from {}.{}').format(sql.Identifier(column),sql.Identifier(column),sql.Identifier(schema),sql.Identifier(table)),(sequence,))


def storage_sync(client, manifest, entries, root):
    wanted = {(item['bucket'],item['key']) for item in entries}
    buckets = {item['Name'] for item in client.list_buckets()['Buckets']}
    for bucket in manifest['storage_buckets']:
        if bucket not in buckets:
            client.create_bucket(Bucket=bucket)
        for item in entries:
            if item['bucket'] != bucket:
                continue
            options = {k:v for k,v in {'ContentType':item.get('content_type'),'CacheControl':item.get('cache_control'),'Metadata':item.get('metadata',{})}.items() if v is not None}
            with (root/item['path']).open('rb') as content:
                client.put_object(Bucket=bucket,Key=item['key'],Body=content,**options)
            with closing(client.get_object(Bucket=bucket,Key=item['key'])['Body']) as content:
                if bk.hash_stream(content) != (item['size'],item['sha256']):
                    raise bk.BackupError('RESTORE_STORAGE_VERIFY')
    # Keep bucket configuration, remove only objects absent in this explicitly confirmed restore.
    for bucket in buckets | set(manifest['storage_buckets']):
        keys = []
        for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket):
            keys.extend(item['Key'] for item in page.get('Contents',[]) if (bucket,item['Key']) not in wanted)
        for key in keys:
            client.delete_object(Bucket=bucket,Key=key)


def restore(db, job, update):
    identity = decrypt_identity(db, job)
    with tempfile.TemporaryDirectory(prefix='owner-restore-') as name:
        root = Path(name); key = root/'identity'; key.write_text(identity+'\n'); key.chmod(0o600)
        # Wrong key/project/archive/schema is rejected before any production writes.
        update('validating')
        verified_download(db, job['object_key'], root/'encrypted.age')
        bk.run_client(['age','--decrypt','-i',str(key),'-o',str(root/'archive.tar.gz'),str(root/'encrypted.age')])
        key.unlink(); identity = None
        manifest, entries = extract_verified(root/'archive.tar.gz',root/'selected')
        with staging_database(root) as stage, closing(connection()) as transaction:
            business,copies,ids,emails = prepare_data(db,stage,root,root/'selected/database.dump')
            db.rollback()
            update('maintenance')
            with db.cursor() as cur:
                cur.execute('update owner_private.runtime_state set maintenance=true,current_job=%s,updated_at=now() where id',(job['id'],))
            db.commit(); storage_started = False; safety = None; committed = False
            try:
                with transaction.cursor() as cur:
                    cur.execute("set local lock_timeout='60s';set local statement_timeout='15min'")
                    for table in sorted(business + list(EPHEMERAL)):
                        cur.execute('select to_regclass(%s)',('public.'+table,))
                        if cur.fetchone()[0]:
                            cur.execute(sql.SQL('lock table public.{} in share row exclusive mode').format(sql.Identifier(table)))
                    cur.execute('lock table auth.users in share row exclusive mode')
                    # Refuse any platform schema variant that can cascade Auth deletion into Storage metadata.
                    cur.execute("select count(*) from pg_constraint where contype='f' and conrelid=to_regclass('storage.objects') and confrelid='auth.users'::regclass")
                    if cur.fetchone()[0]:
                        raise bk.BackupError('STORAGE_SCHEMA_UNSUPPORTED')
                update('safety_backup')
                safety = bk.backup(root/'safety')
                update('restoring_database')
                apply_data(transaction,stage,business,copies,ids,emails)
                update('restoring_storage'); storage_started = True
                storage_sync(storage(),manifest,entries,root/'selected')
                transaction.commit(); committed = True
                with db.cursor() as cur:
                    cur.execute('update owner_private.runtime_state set session_cutoff=now(),maintenance=false,current_job=null,updated_at=now() where id')
                db.commit()
                return {'safety_backup':safety['object_key'],'restored_backup':job['object_key'],'files':len(entries),'accounts_relogin':True}
            except Exception:
                transaction.rollback()
                if committed:
                    # A failed control-state write after commit must never be described as a rolled-back restore.
                    raise bk.BackupError('RECOVERY_REQUIRED') from None
                if storage_started:
                    try:
                        safe_manifest = json.loads((root/'safety/manifest.json').read_text())
                        safe_entries = [json.loads(line) for line in (root/'safety/storage.jsonl').read_text().splitlines()]
                        storage_sync(storage(),safe_manifest,safe_entries,root/'safety')
                    except Exception:
                        raise bk.BackupError('RECOVERY_REQUIRED') from None
                with db.cursor() as cur:
                    cur.execute('update owner_private.runtime_state set maintenance=false,current_job=null,updated_at=now() where id')
                db.commit()
                raise


def cleanup(db):
    deleted=0; changed=0
    with db.cursor() as cur:
        cur.execute('select bucket_id,object_name,expected_etag from owner_private.disposable_files where expires_at<now() order by bucket_id,object_name')
        rows=cur.fetchall()
    client = storage()
    for bucket,name,etag in rows:
        if not name.startswith('owner-temp/'):
            continue
        try:
            current = client.head_object(Bucket=bucket,Key=name)
            if current['ETag'].strip('"') != etag.strip('"'):
                changed+=1; continue
            # Registered files are write-protected by restrictive RLS; only this serialized worker can delete them.
            client.delete_object(Bucket=bucket,Key=name)
            deleted+=1
        except ClientError as error:
            if error.response.get('Error',{}).get('Code') not in ('404','NoSuchKey','NotFound'):
                raise
        with db.cursor() as cur:
            cur.execute('delete from owner_private.disposable_files where bucket_id=%s and object_name=%s and expected_etag=%s',(bucket,name,etag))
        db.commit()
    return {'deleted':deleted,'skipped_changed':changed}


def main():
    os.umask(0o077)
    with closing(connection()) as db:
        with db.cursor() as cur:
            for attempt in range(36):
                cur.execute("select to_regclass('owner_private.backup_jobs')")
                if cur.fetchone()[0] is not None:
                    break
                db.rollback();time.sleep(5)
            else:
                raise bk.BackupError('MIGRATION_PENDING')
            cur.execute("select pg_try_advisory_lock(hashtextextended('owner-backup-worker',0))")
            if not cur.fetchone()[0]:
                return
            # A killed restore must stay locked for recovery, never automatically unlock a partial Storage change.
            cur.execute("update owner_private.backup_jobs set status=case when action='restore' then 'recovery_required' else 'failed' end,error_code='WORKER_INTERRUPTED',encrypted_identity=null,finished_at=now() where status='running'")
            cur.execute('update owner_private.runtime_state set worker_seen_at=now(),worker_run_url=%s where id',(os.environ.get('WORKER_RUN_URL'),))
        db.commit();ensure_transport(db)
        # Synchronize daily backups as well, even when the UI has not requested a scan.
        sync_catalog(db)
        if os.environ.get('VERIFY_BACKUP') == 'true':
            verified=bk.backup();sync_catalog(db)
            client,bucket=b2()
            signed=client.generate_presigned_url('get_object',Params={'Bucket':bucket,'Key':verified['object_key']},ExpiresIn=60)
            with urllib.request.urlopen(urllib.request.Request(signed,headers={'Range':'bytes=0-31'}),timeout=60) as response:
                if response.status != 206 or len(response.read(33)) != 32:
                    raise bk.BackupError('SIGNED_DOWNLOAD_FAILED')
            Path('artifacts/verification').mkdir(parents=True,exist_ok=True)
            Path('artifacts/verification/owner-backup.json').write_text(json.dumps({'sourceCommit':os.environ.get('GITHUB_SHA'),'created_at':verified['created_at'],'size_bytes':verified['size_bytes'],'sha256':verified['sha256'],'remoteChecksumVerified':True,'privateSignedDownloadVerified':True,'catalogSynchronized':True},indent=2)+'\n')
        for _ in range(10):
            lease = str(uuid4())
            with db.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("select * from owner_private.backup_jobs where status='queued' order by created_at for update skip locked limit 1")
                job = cur.fetchone()
                if not job:
                    db.rollback();break
                cur.execute('select active from public.subscription_owners where user_id=%s',(job['actor_id'],))
                owner = cur.fetchone()
                if not owner or not owner['active']:
                    cur.execute("update owner_private.backup_jobs set status='failed',error_code='OWNER_REVOKED',encrypted_identity=null,finished_at=now() where id=%s",(job['id'],));db.commit();continue
                cur.execute('select maintenance from owner_private.runtime_state where id')
                if cur.fetchone()['maintenance']:
                    db.rollback();break
                cur.execute("update owner_private.backup_jobs set status='running',stage='starting',lease_id=%s,started_at=now(),heartbeat_at=now() where id=%s",(lease,job['id']))
            db.commit()
            def update(stage):
                with db.cursor() as cur:
                    cur.execute("update owner_private.backup_jobs set stage=%s,heartbeat_at=now() where id=%s and lease_id=%s and status='running'",(stage,job['id'],lease))
                    if cur.rowcount != 1:
                        raise bk.BackupError('LEASE_LOST')
                    cur.execute('update owner_private.runtime_state set worker_seen_at=now() where id')
                db.commit()
            try:
                if job['action']=='catalog':
                    result=sync_catalog(db)
                elif job['action']=='create':
                    update('exporting');result=bk.backup();sync_catalog(db)
                elif job['action']=='download':
                    client,bucket=b2();expires=datetime.now(timezone.utc)+timedelta(minutes=10)
                    result={'url':client.generate_presigned_url('get_object',Params={'Bucket':bucket,'Key':job['object_key']},ExpiresIn=600),'expires_at':expires.isoformat()}
                elif job['action']=='restore':
                    result=restore(db,job,update);sync_catalog(db)
                else:
                    update('cleaning');result=cleanup(db)
                with db.cursor() as cur:
                    cur.execute("update owner_private.backup_jobs set status='succeeded',stage='done',result=%s,encrypted_identity=null,finished_at=now() where id=%s and lease_id=%s",(Json(result),job['id'],lease))
            except Exception as error:
                db.rollback();code=str(error) if isinstance(error,bk.BackupError) and re.fullmatch('[A-Z_]{3,60}',str(error)) else 'OPERATION_FAILED'
                with db.cursor() as cur:
                    cur.execute("update owner_private.backup_jobs set status=%s,error_code=%s,encrypted_identity=null,finished_at=now() where id=%s and lease_id=%s",('recovery_required' if code=='RECOVERY_REQUIRED' else 'failed',code,job['id'],lease))
                print('Owner operation failed:',code)
            db.commit()
        # Expired download URLs/old encrypted envelopes are not retained as ongoing access paths.
        with db.cursor() as cur:
            cur.execute("update owner_private.backup_jobs set result=result-'url' where result?'url' and finished_at<now()-interval '10 minutes'")
        db.commit()
    print('Owner operations worker finished.')


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        # Database/SDK exceptions may contain credentials, URLs or private file names.
        raise SystemExit('Owner worker failed: '+type(error).__name__) from None
