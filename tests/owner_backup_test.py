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
from contextlib import closing, contextmanager
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

    def test_real_database_round_trip_owner_preservation_and_rollback(self):
        uri=os.environ.get('OWNER_TEST_URL','');parsed=urlparse(uri)
        self.assertIn(parsed.hostname,['127.0.0.1','localhost'])
        production=uri.rsplit('/',1)[0]+'/owner_restore_test';stage_url=uri.rsplit('/',1)[0]+'/owner_stage_test'
        with closing(psycopg2.connect(production)) as db,closing(psycopg2.connect(stage_url)) as stage,tempfile.TemporaryDirectory() as temp:
            root=Path(temp);env=dict(os.environ,PGHOST=parsed.hostname,PGPORT=str(parsed.port or 5432),PGUSER=parsed.username,PGPASSWORD=parsed.password or '',PGDATABASE='owner_restore_test')
            bk.run_client(['pg_dump','--format=custom','--file='+str(root/'database.dump')],env)
            with db.cursor() as cur:
                cur.execute("update products set name='Newer product',price=200;update auth.users set encrypted_password='owner-after-snapshot' where email='owner@example.test';update project_subscription set renewal_amount=2500,valid_until='2028-12-31'")
            db.commit()
            business,copies,ids,emails=op.prepare_data(db,stage,root,root/'database.dump')
            op.apply_data(db,stage,business,copies,ids,emails)
            with db.cursor() as cur:
                cur.execute('select name,price from products');self.assertEqual(cur.fetchone(),('Snapshot product',100))
                cur.execute("select encrypted_password from auth.users where email='owner@example.test'");self.assertEqual(cur.fetchone()[0],'owner-after-snapshot')
                cur.execute('select renewal_amount,valid_until::text from project_subscription');self.assertEqual(cur.fetchone(),(2500,'2028-12-31'))
                cur.execute('select count(*) from auth.identities');self.assertEqual(cur.fetchone()[0],2)
                cur.execute('select count(*) from auth.sessions');self.assertEqual(cur.fetchone()[0],1,'subscriber sessions are invalidated; owner session survives')
            db.rollback()
            with db.cursor() as cur:
                cur.execute('select name,price from products');self.assertEqual(cur.fetchone(),('Newer product',200),'failed restore rolls SQL back')
                cur.execute('select count(*) from auth.sessions');self.assertEqual(cur.fetchone()[0],2)
            op.apply_data(db,stage,business,copies,ids,emails);db.commit()
            with db.cursor() as cur:
                cur.execute('select name from products');self.assertEqual(cur.fetchone()[0],'Snapshot product')

            # Exercise the complete orchestration with real SQL and a deterministic S3 transport.
            payload=b'snapshot-image';(root/'selected').mkdir();shutil.copyfile(root/'database.dump',root/'selected/database.dump')
            (root/'selected/objects').mkdir();(root/'selected/objects/000000000000').write_bytes(payload)
            manifest={'format':1,'project':bk.PROJECT,'storage_buckets':['files'],'storage_object_count':1}
            entry={'bucket':'files','key':'invoice.png','path':'objects/000000000000','size':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}
            (root/'selected/manifest.json').write_text(json.dumps(manifest));(root/'selected/storage.jsonl').write_text(json.dumps(entry)+'\n')
            with tarfile.open(root/'selected.tar.gz','w:gz') as archive:
                archive.add(root/'selected',arcname='.')
            with db.cursor() as cur:
                cur.execute("update products set name='Current before restore';insert into owner_private.backup_jobs(action)values('restore') returning id")
                job_id=cur.fetchone()[0]
            db.commit()
            class S3:
                def __init__(self):self.objects={('files','invoice.png'):b'current-image',('files','extra.png'):b'extra'};self.fail=False
                def list_buckets(self):return {'Buckets':[{'Name':'files'}]}
                def create_bucket(self,**kw):pass
                def put_object(self,Bucket,Key,Body,**kw):
                    self.objects[(Bucket,Key)]=Body.read()
                    if self.fail:self.fail=False;raise RuntimeError('simulated transport failure after write')
                def get_object(self,Bucket,Key):return {'Body':io.BytesIO(self.objects[(Bucket,Key)])}
                def delete_object(self,Bucket,Key):del self.objects[(Bucket,Key)]
                def get_paginator(self,name):return self
                def paginate(self,Bucket):return [{'Contents':[{'Key':key} for bucket,key in self.objects if bucket==Bucket]}]
            cloud=S3();before=dict(cloud.objects)
            def safety(path):
                path.mkdir();(path/'objects').mkdir();items=[]
                for index,((bucket,key),content) in enumerate(cloud.objects.items()):
                    name=f'objects/{index:012d}';(path/name).write_bytes(content);items.append({'bucket':bucket,'key':key,'path':name,'size':len(content),'sha256':hashlib.sha256(content).hexdigest()})
                (path/'manifest.json').write_text(json.dumps({'storage_buckets':['files']}));(path/'storage.jsonl').write_text('\n'.join(json.dumps(v) for v in items))
                return {'object_key':'safety-test-only'}
            @contextmanager
            def isolated_stage(_):
                with stage.cursor() as cur:cur.execute('drop schema auth cascade;drop schema public cascade;create schema public')
                stage.commit();yield stage
            original_run=bk.run_client
            def run(command,env=None):
                if command[0]=='age':shutil.copyfile(command[-1],command[command.index('-o')+1])
                else:original_run(command,env)
            with patch.object(op,'decrypt_identity',return_value='isolated-test-key'),patch.object(op,'verified_download',side_effect=lambda _,__,out:shutil.copyfile(root/'selected.tar.gz',out)),patch.object(op,'staging_database',isolated_stage),patch.object(op,'connection',side_effect=lambda:psycopg2.connect(production)),patch.object(op,'storage',return_value=cloud),patch.object(bk,'backup',side_effect=safety),patch.object(bk,'run_client',side_effect=run):
                cloud.fail=True
                with self.assertRaises(RuntimeError):op.restore(db,{'id':job_id,'object_key':'test-only'},lambda stage:None)
                self.assertEqual(cloud.objects,before,'failed Storage step restores every previous file')
                with db.cursor() as cur:
                    cur.execute('select name from products');self.assertEqual(cur.fetchone()[0],'Current before restore')
                    cur.execute('select maintenance from owner_private.runtime_state');self.assertFalse(cur.fetchone()[0])
                db.rollback()
                result=op.restore(db,{'id':job_id,'object_key':'test-only'},lambda stage:None)
                self.assertEqual(result['safety_backup'],'safety-test-only');self.assertEqual(cloud.objects,{('files','invoice.png'):payload})
                with db.cursor() as cur:
                    cur.execute('select name from products');self.assertEqual(cur.fetchone()[0],'Snapshot product')
                    cur.execute('select maintenance,session_cutoff is not null from owner_private.runtime_state');self.assertEqual(cur.fetchone(),(False,True))
                    cur.execute("select encrypted_password from auth.users where email='owner@example.test'");self.assertEqual(cur.fetchone()[0],'owner-after-snapshot')

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
