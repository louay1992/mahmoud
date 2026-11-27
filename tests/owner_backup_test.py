"""Real PostgreSQL COPY round-trip and rollback; synthetic data, no production credentials."""
import base64
import io
import json
import os
import sys
import tarfile
import tempfile
import unittest
import hashlib
import shutil
import subprocess
from contextlib import closing, contextmanager, nullcontext
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/backup'))
import operations as op
import backup as bk
import psycopg2
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


class OperationsTest(unittest.TestCase):
    @unittest.skipIf(os.environ.get('OWNER_TEST_SKIP_SOCKET')=='true','Local executor does not support Unix sockets; GitHub runs this test')
    def test_private_staging_is_isolated(self):
        with tempfile.TemporaryDirectory() as temp:
            with op.staging_database(Path(temp)) as db,db.cursor() as cur:
                cur.execute('select current_database(),count(*) from pg_tables where schemaname=\'public\' group by current_database()')
                self.assertIsNone(cur.fetchone())
                cur.execute('select 1');self.assertEqual(cur.fetchone()[0],1)

    def test_archive_rejects_traversal_and_symlinks(self):
        for name,kind in [('../escape',tarfile.REGTYPE),('objects/000000000001',tarfile.SYMTYPE)]:
            with tempfile.TemporaryDirectory() as temp:
                root=Path(temp)
                with tarfile.open(root/'bad.tar.gz','w:gz') as archive:
                    member=tarfile.TarInfo(name);member.type=kind;member.linkname='/etc/passwd';archive.addfile(member,io.BytesIO(b''))
                with self.assertRaisesRegex(bk.BackupError,'ARCHIVE_UNSAFE'):
                    op.extract_verified(root/'bad.tar.gz',root/'out')

    def test_real_database_round_trip_auth_preservation_and_recovery(self):
        uri=os.environ.get('OWNER_TEST_URL','');parsed=urlparse(uri)
        self.assertIn(parsed.hostname,['127.0.0.1','localhost'])
        production=uri.rsplit('/',1)[0]+'/owner_restore_test';stage_url=uri.rsplit('/',1)[0]+'/owner_stage_test'
        with closing(psycopg2.connect(production)) as db,closing(psycopg2.connect(stage_url)) as stage,tempfile.TemporaryDirectory() as temp:
            root=Path(temp);env=dict(os.environ,PGHOST=parsed.hostname,PGPORT=str(parsed.port or 5432),PGUSER=parsed.username,PGPASSWORD=parsed.password or '',PGDATABASE='owner_restore_test')
            bk.run_client(['pg_dump','--format=custom','--file='+str(root/'database.dump')],env)
            with db.cursor() as cur:
                cur.execute("select to_regclass('public.order_submissions') is not null")
                ledger = cur.fetchone()[0]
                cur.execute("""update products set name='Newer product',price=200;
                    update auth.users set encrypted_password='current-password' where email='company@example.test';
                    delete from admins where email='removed@example.test';
                    delete from auth.users where email='removed@example.test';
                    update admins set perms=array['view_orders'] where email='company@example.test';
                    update project_subscription set renewal_amount=2500,valid_until='2028-12-31';
                    delete from captain_payments;
                    delete from orders;
                    delete from captains where email='archive@example.test';
                    update captains set active=false,email='current-captain@example.test' where email='old-captain@example.test';
                    insert into orders(order_no,customer_name,customer_phone) overriding system value values(25,'Current customer','555444');
                    select setval('orders_order_no_seq',25)""")
                if ledger:
                    cur.execute("""insert into order_submissions(actor_id,request_id,fingerprint,order_id)
                        select '00000000-0000-4000-8000-000000000902','00000000-0000-4000-8000-000000000932',decode('02','hex'),id
                        from orders where order_no=25""")
            db.commit()

            self.assertEqual(len(op.prepare_data(db,stage,root,root/'database.dump')),2)
            db.rollback()
            can_encrypt = shutil.which('age') and shutil.which('age-keygen')
            if can_encrypt:
                key_path = root/'local-test-key'
                subprocess.run(['age-keygen','-o',str(key_path)],check=True,capture_output=True,text=True)
                recipient = subprocess.check_output(['age-keygen','-y',str(key_path)],text=True).strip()
                test_key = next(line for line in key_path.read_text().splitlines() if line.startswith('AGE-SECRET-KEY-1'))
            else:
                test_key = 'isolated-test-key'

            def make_snapshot(path, objects):
                path.mkdir()
                (path/'objects').mkdir()
                shutil.copyfile(root/'database.dump',path/'database.dump')
                entries = []
                for index,((bucket,key),content) in enumerate(objects.items()):
                    relative = f'objects/{index:012d}'
                    (path/relative).write_bytes(content)
                    entries.append({'bucket':bucket,'key':key,'path':relative,'size':len(content),'sha256':hashlib.sha256(content).hexdigest()})
                (path/'manifest.json').write_text(json.dumps({'format':1,'project':bk.PROJECT,'storage_buckets':['files'],'storage_object_count':len(entries)}))
                (path/'storage.jsonl').write_text('\n'.join(json.dumps(entry) for entry in entries))

            def pack(path, name):
                archive = root/f'{name}.tar.gz'
                with tarfile.open(archive,'w:gz') as handle:
                    handle.add(path,arcname='.')
                if not can_encrypt:
                    return archive
                encrypted = archive.with_suffix('.gz.age')
                bk.run_client(['age','-r',recipient,'-o',str(encrypted),str(archive)])
                return encrypted

            snapshot = {('files','invoice.png'):b'snapshot-image'}
            make_snapshot(root/'selected',snapshot)
            archived = pack(root/'selected','selected')
            object_key = 'delivery-production/2026/11/27/20261127T000001Z-'+'a'*32+'.tar.gz.age'
            safety_key = 'delivery-production/2026/11/27/20261127T000002Z-'+'b'*32+'.tar.gz.age'
            owner_id = '00000000-0000-4000-8000-000000000901'

            def enqueue():
                with db.cursor() as cur:
                    op.register_verified(cur,{'object_key':object_key,'created_at':'2026-11-27T00:00:01Z','size_bytes':archived.stat().st_size,'sha256':hashlib.sha256(archived.read_bytes()).hexdigest()})
                    cur.execute("""insert into owner_private.backup_jobs(actor_id,action,object_key,encrypted_identity)
                        values(%s,'restore',%s,'synthetic') returning id""",(owner_id,object_key))
                    job_id = cur.fetchone()[0]
                db.commit()
                op.mark_interrupted(db)
                job = op.claim_job(db)
                self.assertEqual(job['id'],job_id)
                return job

            class S3:
                def __init__(self):
                    self.objects={('files','invoice.png'):b'current-image',('files','extra.png'):b'extra'}
                    self.failures=0
                def list_buckets(self):return {'Buckets':[{'Name':'files'}]}
                def create_bucket(self,**kw):pass
                def put_object(self,Bucket,Key,Body,**kw):
                    self.objects[(Bucket,Key)]=Body.read()
                    if self.failures:
                        self.failures-=1
                        raise RuntimeError('simulated transport failure after write')
                def get_object(self,Bucket,Key):return {'Body':io.BytesIO(self.objects[(Bucket,Key)])}
                def delete_object(self,Bucket,Key):del self.objects[(Bucket,Key)]
                def get_paginator(self,name):return self
                def paginate(self,Bucket):return [{'Contents':[{'Key':key} for bucket,key in self.objects if bucket==Bucket]}]
            cloud=S3();before=dict(cloud.objects);remote={object_key:archived}
            def safety(path):
                make_snapshot(path,cloud.objects)
                archive=pack(path,'safety-'+str(len(list(root.glob('safety-*.tar.gz')))))
                remote[safety_key]=archive
                return {'object_key':safety_key,'created_at':'2026-11-27T00:00:02Z',
                    'size_bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}
            original_run=bk.run_client
            def run(command,env=None):
                if command[0]=='age' and not can_encrypt:shutil.copyfile(command[-1],command[command.index('-o')+1])
                else:original_run(command,env)

            class Backblaze:
                bucket = 'isolated-backup-bucket'
                def get_object(self,Bucket,Key):
                    assert Bucket == self.bucket
                    return {'Body':remote[Key].open('rb')}

            @contextmanager
            def loopback_stage(_):
                with stage.cursor() as cur:
                    cur.execute('drop schema public cascade;create schema public')
                stage.commit()
                yield stage

            staging = (patch.object(op,'staging_database',loopback_stage)
                if os.environ.get('OWNER_TEST_SKIP_SOCKET')=='true' else nullcontext())
            with patch.object(op,'decrypt_identity',return_value=test_key), \
                 patch.object(op,'b2',return_value=(Backblaze(),Backblaze.bucket)), \
                 patch.object(op,'connection',side_effect=lambda:psycopg2.connect(production)), \
                 patch.object(op,'storage',return_value=cloud),patch.object(bk,'backup',side_effect=safety), \
                 patch.object(bk,'run_client',side_effect=run), staging:
                first = enqueue()
                cloud.failures=2
                op.process_job(db,first)
                with db.cursor() as cur:
                    cur.execute('select name from products');self.assertEqual(cur.fetchone()[0],'Newer product')
                    cur.execute('select last_value,is_called from orders_order_no_seq');self.assertEqual(cur.fetchone(),(25,True))
                    cur.execute('select maintenance,current_job::text from owner_private.runtime_state');self.assertEqual(cur.fetchone(),(True,first['id']))
                    cur.execute('select status,stage,safety_backup_key,storage_dirty from owner_private.backup_jobs where id=%s',(first['id'],))
                    self.assertEqual(cur.fetchone(),('recovery_required','recovery_waiting',safety_key,True))
                    # Simulate a fresh envelope already verified by the owner-only resume RPC.
                    cur.execute("update owner_private.backup_jobs set stage='recovery_queued',encrypted_identity='synthetic' where id=%s",(first['id'],))
                db.commit()
                retry=op.claim_job(db)
                self.assertEqual(retry['id'],first['id'])
                # A later tick after an interruption retains the authorized recovery and safety key.
                op.mark_interrupted(db)
                retry=op.claim_job(db)
                op.process_job(db,retry)
                self.assertEqual(cloud.objects,before)
                with db.cursor() as cur:
                    cur.execute('select maintenance from owner_private.runtime_state');self.assertFalse(cur.fetchone()[0])
                    cur.execute('select status,error_code,encrypted_identity from owner_private.backup_jobs where id=%s',(first['id'],))
                    self.assertEqual(cur.fetchone(),('failed','RESTORE_ROLLED_BACK',None))
                second=enqueue()
                op.process_job(db,second)
                self.assertEqual(cloud.objects,snapshot)
                with db.cursor() as cur:
                    cur.execute('select name from products');self.assertEqual(cur.fetchone()[0],'Snapshot product')
                    cur.execute('select maintenance,session_cutoff is not null from owner_private.runtime_state');self.assertEqual(cur.fetchone(),(False,True))
                    cur.execute("select encrypted_password from auth.users where email='company@example.test'");self.assertEqual(cur.fetchone()[0],'current-password')
                    cur.execute("select count(*) from auth.users where email='removed@example.test'");self.assertEqual(cur.fetchone()[0],0)
                    cur.execute("select count(*) from admins where email='removed@example.test'");self.assertEqual(cur.fetchone()[0],0)
                    cur.execute("select perms from admins where email='company@example.test'");self.assertEqual(cur.fetchone()[0],['view_orders'])
                    cur.execute('select count(*) from auth.sessions');self.assertEqual(cur.fetchone()[0],2)
                    cur.execute('select renewal_amount,valid_until::text from project_subscription');self.assertEqual(cur.fetchone(),(2500,'2028-12-31'))
                    cur.execute('select active,email,phone from captains where id=(select captain_id from orders)');self.assertEqual(cur.fetchone(),(False,None,None))
                    cur.execute("select active,email from captains where name='Snapshot current captain'");self.assertEqual(cur.fetchone(),(False,'current-captain@example.test'))
                    cur.execute('select count(*) from captain_payments');self.assertEqual(cur.fetchone()[0],1)
                    if ledger:
                        cur.execute('select count(*),count(order_id) from order_submissions')
                        self.assertEqual(cur.fetchone(),(2,0),'retired request identifiers must remain consumed')
                    cur.execute('select nextval(\'orders_order_no_seq\')');self.assertEqual(cur.fetchone()[0],26)
                    cur.execute('select status,result->>\'safety_backup\' from owner_private.backup_jobs where id=%s',(second['id'],))
                    self.assertEqual(cur.fetchone(),('succeeded',safety_key))

    def test_resume_requires_current_owner_mfa(self):
        uri=os.environ['OWNER_TEST_URL'].rsplit('/',1)[0]+'/owner_restore_test'
        owner_id='00000000-0000-4000-8000-000000000901'
        session_id='00000000-0000-4000-8000-000000000921'
        with closing(psycopg2.connect(uri)) as db, db.cursor() as cur:
            cur.execute("select to_regprocedure('owner_private.require_owner_mfa()')")
            if not cur.fetchone()[0]:
                self.skipTest('Account-access migration is required')
            op.ensure_transport(db)
            cur.execute('select id from owner_private.backup_keys order by created_at desc limit 1')
            key_id=cur.fetchone()[0]
            op.register_verified(cur,{'object_key':'isolated-retry','created_at':'2026-11-27T00:00:00Z','size_bytes':1,'sha256':'a'*64})
            cur.execute("""insert into owner_private.backup_jobs(action,status,stage,safety_backup_key,storage_dirty)
                values('restore','recovery_required','recovery_waiting','isolated-retry',true) returning id""")
            job_id=cur.fetchone()[0]
            cur.execute('update owner_private.runtime_state set maintenance=true,current_job=%s where id',(job_id,))
            cur.execute('set local role authenticated')
            claims={'sub':owner_id,'session_id':session_id,'role':'authenticated','email':'owner@example.test','aal':'aal1'}
            cur.execute('select set_config(%s,%s,true)',('request.jwt.claims',json.dumps(claims)))
            cur.execute('savepoint unauthorized_recovery')
            statement="select public.owner_resume_backup_restore(%s,%s,%s,'استعادة')"
            params=(job_id,'A'*512,key_id)
            with self.assertRaises(psycopg2.Error) as rejected:
                cur.execute(statement,params)
            self.assertEqual(rejected.exception.pgcode,'PT403')
            cur.execute('rollback to unauthorized_recovery')
            claims['aal']='aal2'
            cur.execute('select set_config(%s,%s,true)',('request.jwt.claims',json.dumps(claims)))
            cur.execute(statement,params)
            self.assertEqual(cur.fetchone()[0]['stage'],'recovery_queued')
            cur.execute('select public.owner_backup_console()')
            jobs=cur.fetchone()[0]['jobs']
            job=next(data for data in jobs if data['id']==job_id)
            self.assertEqual(job['safety_backup_key'],'isolated-retry')
            self.assertFalse(job['recoverable'])
            self.assertNotIn('encrypted_identity',job)
            db.rollback()

    def test_transport_envelope_round_trip(self):
        parsed=urlparse(os.environ['OWNER_TEST_URL']);uri=os.environ['OWNER_TEST_URL'].rsplit('/',1)[0]+'/owner_restore_test'
        with closing(psycopg2.connect(uri)) as db:
            # The disposable DB uses a passwordless local connection; the purpose-separated KDF still accepts it.
            op.ensure_transport(db)
            with db.cursor() as cur:
                cur.execute('select id,public_jwk,encrypted_private_key,salt,nonce from owner_private.backup_keys limit 1');key,jwk,encrypted,salt,nonce=cur.fetchone()
            pem=op.AESGCM(op.transport_secret(db.info.password or '',bytes(salt))).decrypt(bytes(nonce),bytes(encrypted),bk.PROJECT.encode())
            public=serialization.load_pem_private_key(pem,password=None).public_key()
            identity='AGE-SECRET-KEY-1'+'A'*58
            envelope=public.encrypt(identity.encode(),padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=None))
            self.assertEqual(op.decrypt_identity(db,{'transport_key_id':key,'encrypted_identity':base64.b64encode(envelope).decode()}),identity)
            with self.assertRaisesRegex(bk.BackupError,'RECOVERY_KEY_INVALID'):
                op.decrypt_identity(db,{'transport_key_id':key,'encrypted_identity':'AAAA'})


if __name__=='__main__':
    unittest.main()
