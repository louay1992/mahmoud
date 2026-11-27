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
PRESERVE = {'admins', 'subscription_owners', 'project_subscription', 'subscription_changes', 'subscription_admin_invites', 'push_config', 'native_push_devices', 'native_push_preferences', 'push_subscriptions'}
BUSINESS = {'captains','captain_payments','carriers','carrier_payments','customers','marketers','marketer_payments','notifications','orders','order_items','order_events','order_item_capital','price_requests','products','settings','shipment_events','stock','stock_invoices','stock_invoice_items','stock_movements','warehouses'}
EPHEMERAL = {'op_guard'}
OPTIONAL_RESTORE = {'order_submissions'}


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


def register_verified(cursor, backup):
    cursor.execute('''insert into owner_private.backup_catalog
        (object_key,created_at,size_bytes,sha256,verified,metadata) values(%s,%s,%s,%s,true,%s)
        on conflict(object_key) do update set size_bytes=excluded.size_bytes,sha256=excluded.sha256,
        verified=true,metadata=excluded.metadata,last_seen_at=now()''',
        (backup['object_key'],backup['created_at'],backup['size_bytes'],backup['sha256'],Json(backup.get('metadata', {}))))


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
        if tables - OPTIONAL_RESTORE != BUSINESS | PRESERVE | EPHEMERAL:
            raise bk.BackupError('SCHEMA_INCOMPATIBLE')
        business = sorted(BUSINESS | (tables & OPTIONAL_RESTORE))
        cur.execute("select table_schema,table_name,column_name,is_generated from information_schema.columns where table_schema='public' order by ordinal_position")
        columns = {}
        for schema, table, column, generated in cur.fetchall():
            if generated == 'NEVER':
                columns.setdefault((schema, table), []).append(column)
    allowed = {('public', name) for name in business}
    with stage.cursor() as cur:
        for schema, table in sorted(allowed):
            defs = sql.SQL(',').join(sql.SQL('{} text').format(sql.Identifier(name)) for name in columns[(schema,table)])
            cur.execute(sql.SQL('create table {}.{}({})').format(sql.Identifier(schema), sql.Identifier(table), defs))
    stage.commit()
    data_sql = root/'data.sql'
    bk.run_client(['pg_restore', '--data-only', '--no-owner', '--no-privileges', '--schema=public', f'--file={data_sql}', str(dump)])
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
    if any(('public', table) not in copies for table in BUSINESS):
        # Older snapshots lacking newly introduced business tables fail closed, before maintenance.
        raise bk.BackupError('SCHEMA_INCOMPATIBLE')
    stage.commit()
    return business, copies


def apply_data(production, stage, business, copies):
    with production.cursor() as cur:
        # Business triggers must not send notifications or recalculate historical totals on import.
        cur.execute("set local session_replication_role='replica'")
        cur.execute('create temp table restore_warehouse_assignments on commit drop as select id,captain_id from public.warehouses')
        cur.execute('create temp table restore_captains (like public.captains) on commit drop')
        if ('public','order_submissions') in copies:
            cur.execute('create temp table restore_order_submissions (like public.order_submissions) on commit drop')
        for table in business + sorted(EPHEMERAL):
            if table not in ('captains','order_submissions'):
                cur.execute(sql.SQL('delete from public.{}').format(sql.Identifier(table)))
        for table in business:
            columns = copies.get(('public',table))
            if not columns:
                continue
            names = sql.SQL(',').join(map(sql.Identifier,columns))
            origin = sql.SQL('public.{} ({})').format(sql.Identifier(table), names)
            target = (sql.SQL('pg_temp.{} ({})').format(sql.Identifier('restore_'+table),names)
                if table in ('captains','order_submissions') else origin)
            with tempfile.TemporaryFile(mode='w+',encoding='utf-8',newline='') as content, stage.cursor() as source:
                source.copy_expert(sql.SQL('copy {} to stdout').format(origin).as_string(stage),content)
                content.seek(0); cur.copy_expert(sql.SQL('copy {} from stdin').format(target).as_string(production),content)
        # Keep revoked historical captains inert while retaining order and payment foreign keys.
        cur.execute('''insert into public.captains (id,name,delivery_fee,active,created_at)
            select a.id,a.name,a.delivery_fee,false,a.created_at from restore_captains a
            where not exists (select 1 from public.captains c where c.id=a.id)''')
        cur.execute('''update public.captains c set warehouse_id=null where c.warehouse_id is not null
            and not exists (select 1 from public.warehouses w where w.id=c.warehouse_id)''')
        cur.execute('update public.warehouses set captain_id=null where captain_id is not null')
        cur.execute('''update public.warehouses w set captain_id=a.captain_id
            from restore_warehouse_assignments a where a.id=w.id and a.captain_id is not null''')
        if 'order_submissions' in business:
            # Keep consumed request identifiers even when the associated order falls outside this snapshot.
            cur.execute('''update public.order_submissions s set order_id=null where s.order_id is not null
                and not exists (select 1 from public.orders o where o.id=s.order_id)''')
        if ('public','order_submissions') in copies:
            cur.execute('''insert into public.order_submissions(actor_id,request_id,fingerprint,order_id,created_at)
                select s.actor_id,s.request_id,s.fingerprint,o.id,s.created_at from restore_order_submissions s
                left join public.orders o on o.id=s.order_id on conflict(actor_id,request_id) do nothing''')
        cur.execute("set local session_replication_role='origin'")
        # Validate foreign keys skipped during the bulk copy.
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
        cur.execute('select last_value,is_called from public.orders_order_no_seq')
        current, called = cur.fetchone()
        cur.execute('select coalesce(max(order_no),0) from public.orders')
        restored = cur.fetchone()[0]
        cur.execute('alter sequence public.orders_order_no_seq restart with %s', (max(current + called, restored + 1),))


def storage_sync(client, manifest, entries, root):
    wanted = {(item['bucket'],item['key']) for item in entries}
    buckets = {item['Name'] for item in client.list_buckets().get('Buckets', [])}
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
    actual = {(bucket,item['Key']) for bucket in buckets | set(manifest['storage_buckets'])
        for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket) for item in page.get('Contents',[])}
    if actual != wanted:
        raise bk.BackupError('RESTORE_STORAGE_VERIFY')


def read_backup(db, job, object_key, root):
    key = root/'identity'
    identity = decrypt_identity(db, job)
    with open(key,'x',opener=lambda path,flags: os.open(path,flags,0o600)) as stream:
        stream.write(identity+'\n')
    try:
        verified_download(db, object_key, root/'encrypted.age')
        try:
            bk.run_client(['age','--decrypt','-i',str(key),'-o',str(root/'archive.tar.gz'),str(root/'encrypted.age')])
        except bk.BackupError:
            raise bk.BackupError('RECOVERY_KEY_INVALID') from None
    finally:
        key.unlink()
    return extract_verified(root/'archive.tar.gz',root/'selected')


def finish_restore(db, job, status, result=None, error=None):
    with db.cursor() as cur:
        cur.execute('''update owner_private.backup_jobs set status=%s,stage='done',result=%s,error_code=%s,
            encrypted_identity=null,storage_dirty=false,finished_at=clock_timestamp()
            where id=%s and lease_id=%s and status='running' ''',
            (status,Json(result or {}),error,job['id'],job['lease_id']))
        if cur.rowcount != 1:
            raise bk.BackupError('LEASE_LOST')
        cur.execute('''update owner_private.runtime_state set maintenance=false,current_job=null,updated_at=clock_timestamp(),
            session_cutoff=case when %s then clock_timestamp() else session_cutoff end where id and current_job=%s''',
            (status == 'succeeded',job['id']))
        if cur.rowcount != 1:
            raise bk.BackupError('RECOVERY_STATE_CHANGED')
    db.commit()


def complete_recovery(db, job, manifest, entries, path):
    storage_sync(storage(),manifest,entries,path)
    finish_restore(db,job,'failed',error='RESTORE_ROLLED_BACK')


def recover_storage(db, job):
    with tempfile.TemporaryDirectory(prefix='owner-recovery-') as name:
        root = Path(name)
        manifest, entries = read_backup(db,job,job['safety_backup_key'],root)
        db.rollback()
        complete_recovery(db,job,manifest,entries,root/'selected')


def restore(db, job, update):
    with tempfile.TemporaryDirectory(prefix='owner-restore-') as name:
        root = Path(name)
        update('validating')
        manifest, entries = read_backup(db,job,job['object_key'],root)
        with staging_database(root) as stage, closing(connection()) as transaction:
            business,copies = prepare_data(db,stage,root,root/'selected/database.dump')
            db.rollback()
            update('maintenance')
            with db.cursor() as cur:
                cur.execute('update owner_private.runtime_state set maintenance=true,current_job=%s,updated_at=now() where id and not maintenance',(job['id'],))
                if cur.rowcount != 1:
                    raise bk.BackupError('RECOVERY_STATE_CHANGED')
            db.commit()
            try:
                with transaction.cursor() as cur:
                    cur.execute("set local lock_timeout='60s';set local statement_timeout='15min'")
                    for table in sorted(business + list(EPHEMERAL)):
                        cur.execute(sql.SQL('lock table public.{} in share row exclusive mode').format(sql.Identifier(table)))
                update('safety_backup')
                safety = bk.backup(root/'safety')
                with db.cursor() as cur:
                    register_verified(cur,safety)
                    cur.execute('update owner_private.backup_jobs set safety_backup_key=%s where id=%s and lease_id=%s and status=%s',
                        (safety['object_key'],job['id'],job['lease_id'],'running'))
                    if cur.rowcount != 1:
                        raise bk.BackupError('LEASE_LOST')
                db.commit()
                update('restoring_database')
                apply_data(transaction,stage,business,copies)
                with db.cursor() as cur:
                    cur.execute('''update owner_private.backup_jobs set storage_dirty=true,stage='restoring_storage',heartbeat_at=now()
                        where id=%s and lease_id=%s and status='running' ''',(job['id'],job['lease_id']))
                    if cur.rowcount != 1:
                        raise bk.BackupError('LEASE_LOST')
                db.commit()
                storage_sync(storage(),manifest,entries,root/'selected')
                result = {'safety_backup':safety['object_key'],'restored_backup':job['object_key'],'files':len(entries)}
                finish_restore(transaction,job,'succeeded',result=result)
            except Exception:
                # If the database connection dropped during commit, read the committed outcome before touching S3.
                if not transaction.closed:
                    transaction.rollback()
                db.rollback()
                with db.cursor() as cur:
                    cur.execute('select status,storage_dirty from owner_private.backup_jobs where id=%s for update',(job['id'],))
                    status, dirty = cur.fetchone()
                db.commit()
                if status == 'succeeded':
                    return
                if dirty:
                    try:
                        safe_manifest = json.loads((root/'safety/manifest.json').read_text())
                        safe_entries = [json.loads(line) for line in (root/'safety/storage.jsonl').read_text().splitlines()]
                        update('recovering_storage')
                        complete_recovery(db,job,safe_manifest,safe_entries,root/'safety')
                        return
                    except Exception:
                        raise bk.BackupError('RECOVERY_REQUIRED') from None
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


def mark_interrupted(db):
    with db.cursor() as cur:
        cur.execute('''update owner_private.runtime_state r set maintenance=false,current_job=null,updated_at=now()
            from owner_private.backup_jobs j where r.id and r.current_job=j.id and j.status='running'
            and not j.storage_dirty and j.stage not in ('restoring_storage','recovering_storage')''')
        cur.execute('''update owner_private.backup_jobs set
            status=case when storage_dirty or stage in ('restoring_storage','recovering_storage') then 'recovery_required' else 'failed' end,
            stage=case when storage_dirty and encrypted_identity is not null then 'recovery_queued'
                when storage_dirty or stage in ('restoring_storage','recovering_storage') then 'recovery_waiting' else 'done' end,
            error_code='WORKER_INTERRUPTED',finished_at=now() where status='running' ''')
        cur.execute("update owner_private.backup_jobs set encrypted_identity=null where status='failed' and encrypted_identity is not null")
        cur.execute('update owner_private.runtime_state set worker_seen_at=now(),worker_run_url=%s where id',(os.environ.get('WORKER_RUN_URL'),))
    db.commit()


def claim_job(db):
    with db.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('''select j.* from owner_private.backup_jobs j cross join owner_private.runtime_state r
            where r.id and ((r.maintenance and r.current_job=j.id and j.status='recovery_required' and j.stage='recovery_queued')
                or (j.status='queued' and (not r.maintenance or j.action in ('catalog','download'))))
            order by j.storage_dirty desc,j.created_at for update of j skip locked limit 1''')
        job = cur.fetchone()
        if job:
            job['lease_id'] = str(uuid4())
            cur.execute("""update owner_private.backup_jobs set status='running',stage=%s,lease_id=%s,
                started_at=now(),finished_at=null,heartbeat_at=now() where id=%s""",
                ('recovering_storage' if job['storage_dirty'] else 'starting', job['lease_id'],job['id']))
    db.commit()
    return job


def error_code(error):
    code = str(error)
    return code if isinstance(error,bk.BackupError) and re.fullmatch('[A-Z_]{3,60}',code) else 'OPERATION_FAILED'


def fail_job(db, job, code):
    db.rollback()
    with db.cursor() as cur:
        cur.execute('''update owner_private.backup_jobs set
            status=case when storage_dirty then 'recovery_required' else 'failed' end,
            stage=case when storage_dirty then 'recovery_waiting' else 'done' end,
            error_code=%s,encrypted_identity=null,finished_at=now()
            where id=%s and lease_id=%s and status='running' returning storage_dirty''',(code,job['id'],job['lease_id']))
        result = cur.fetchone()
        if result and not result[0]:
            cur.execute('update owner_private.runtime_state set maintenance=false,current_job=null,updated_at=now() where id and current_job=%s',(job['id'],))
    db.commit()
    if result:
        print('Owner operation failed:',code)


def process_job(db, job):
    def update(stage):
        with db.cursor() as cur:
            cur.execute("update owner_private.backup_jobs set stage=%s,heartbeat_at=now() where id=%s and lease_id=%s and status='running'",
                (stage,job['id'],job['lease_id']))
            if cur.rowcount != 1:
                raise bk.BackupError('LEASE_LOST')
            cur.execute('update owner_private.runtime_state set worker_seen_at=now() where id')
        db.commit()

    try:
        # Compensation rolls back a previous operation; revoking that requester cannot leave Storage inconsistent.
        if job['storage_dirty']:
            recover_storage(db,job)
            return
        with db.cursor() as cur:
            cur.execute('select active from public.subscription_owners where user_id=%s',(job['actor_id'],))
            owner = cur.fetchone()
        db.rollback()
        if not owner or not owner[0]:
            raise bk.BackupError('OWNER_REVOKED')
        if job['action']=='restore':
            restore(db,job,update)
            return
        if job['action']=='catalog':
            result=sync_catalog(db)
        elif job['action']=='create':
            update('exporting');result=bk.backup()
            with db.cursor() as cur:
                register_verified(cur,result)
        elif job['action']=='download':
            client,bucket=b2();expires=datetime.now(timezone.utc)+timedelta(minutes=10)
            result={'url':client.generate_presigned_url('get_object',Params={'Bucket':bucket,'Key':job['object_key']},ExpiresIn=600),'expires_at':expires.isoformat()}
        else:
            update('cleaning');result=cleanup(db)
        with db.cursor() as cur:
            cur.execute("update owner_private.backup_jobs set status='succeeded',stage='done',result=%s,encrypted_identity=null,finished_at=now() where id=%s and lease_id=%s and status='running'",
                (Json(result),job['id'],job['lease_id']))
            if cur.rowcount != 1:
                raise bk.BackupError('LEASE_LOST')
        db.commit()
    except Exception as error:
        fail_job(db,job,error_code(error))


def verify_new_backup(db):
    verified=bk.backup()
    with db.cursor() as cur:
        register_verified(cur,verified)
    db.commit()
    client,bucket=b2()
    signed=client.generate_presigned_url('get_object',Params={'Bucket':bucket,'Key':verified['object_key']},ExpiresIn=60)
    with urllib.request.urlopen(urllib.request.Request(signed,headers={'Range':'bytes=0-31'}),timeout=60) as response:
        if response.status != 206 or len(response.read(33)) != 32:
            raise bk.BackupError('SIGNED_DOWNLOAD_FAILED')
    Path('artifacts/verification').mkdir(parents=True,exist_ok=True)
    Path('artifacts/verification/owner-backup.json').write_text(json.dumps({'sourceCommit':os.environ.get('GITHUB_SHA'),'created_at':verified['created_at'],'size_bytes':verified['size_bytes'],'sha256':verified['sha256'],'remoteChecksumVerified':True,'privateSignedDownloadVerified':True,'catalogSynchronized':True},indent=2)+'\n')


def main():
    os.umask(0o077)
    with closing(connection()) as db:
        with db.cursor() as cur:
            for attempt in range(36):
                cur.execute("select exists(select 1 from information_schema.columns where table_schema='owner_private' and table_name='backup_jobs' and column_name='storage_dirty')")
                if cur.fetchone()[0]:
                    break
                db.rollback();time.sleep(5)
            else:
                raise bk.BackupError('MIGRATION_PENDING')
            cur.execute("select pg_try_advisory_lock(hashtextextended('owner-backup-worker',0))")
            if not cur.fetchone()[0]:
                return
        mark_interrupted(db)
        try:
            ensure_transport(db)
            for _ in range(10):
                job = claim_job(db)
                if not job:
                    break
                process_job(db,job)
            sync_catalog(db)
            if os.environ.get('VERIFY_BACKUP') == 'true':
                verify_new_backup(db)
            with db.cursor() as cur:
                cur.execute("update owner_private.backup_jobs set result=result-'url' where result?'url' and finished_at<now()-interval '10 minutes'")
                cur.execute('update owner_private.runtime_state set worker_last_success_at=now(),worker_error_code=null where id')
            db.commit()
        except Exception as error:
            db.rollback()
            with db.cursor() as cur:
                cur.execute('update owner_private.runtime_state set worker_error_code=%s where id',(error_code(error),))
            db.commit()
            raise
    print('Owner operations worker finished.')


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        # Database/SDK exceptions may contain credentials, URLs or private file names.
        raise SystemExit('Owner worker failed: '+type(error).__name__) from None
