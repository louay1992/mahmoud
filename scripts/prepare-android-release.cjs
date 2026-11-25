/* Generate public update metadata only after both APKs have been signed and verified. */
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
function prepare({directory,sourceCommit,notes,gradle}){
 const versionName=gradle.match(/versionName "([0-9]+\.[0-9]+\.[0-9]+)"/)?.[1],versionCode=Number(gradle.match(/versionCode (\d+)/)?.[1]);
 if(!versionName||!Number.isSafeInteger(versionCode)||versionCode<=0||!/^[a-f0-9]{40}$/.test(sourceCommit)||typeof notes!=='string'||notes.length>2000)throw Error('Invalid release version, source or notes');
 const tag='android-v'+versionName,apps={};
 for(const role of ['admin','captain']){
  const filename='Delivery-'+(role==='admin'?'Admin':'Captain')+'-'+versionName+'.apk',bytes=fs.readFileSync(path.join(directory,filename));
  if(bytes.length<=0||bytes.length>100*1024*1024)throw Error('Invalid APK size');
  apps[role]={packageName:'app.hhyyw.'+role,versionCode,versionName,minSdk:23,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),url:'https://github.com/louay1992/mahmoud/releases/download/'+tag+'/'+filename,notes};
 }
 return {schema:1,sourceCommit,generatedAt:new Date().toISOString(),apps};
}
module.exports={prepare};
if(require.main===module){
 const args=process.argv.slice(2),get=(flag,fallback)=>args.includes(flag)?args[args.indexOf(flag)+1]:fallback;
 const root=path.resolve(__dirname,'..'),directory=path.resolve(get('--apks',path.join(root,'artifacts'))),output=path.resolve(get('--output',path.join(root,'artifacts/android-release')));
 const notesFile=get('--notes-file'),notes=notesFile?fs.readFileSync(notesFile,'utf8').trim():'تحديثات وتحسينات لتطبيقي الإدارة والكابتن.';
 const sourceCommit=get('--source',execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim());
 const manifest=prepare({directory,sourceCommit,notes,gradle:fs.readFileSync(path.join(root,'android/app/build.gradle'),'utf8')});
 fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'latest.json'),JSON.stringify(manifest,null,2)+'\n');
 fs.writeFileSync(path.join(output,'release-notes.md'),'تحديث تطبيقي الإدارة والكابتن إلى '+manifest.apps.admin.versionName+'\n\n'+notes+'\n\nالمصدر: `'+sourceCommit+'`\n\nيتطلب التثبيت تأكيد Android، وتبقى بيانات التطبيق محفوظة.\n');
 console.log('Prepared Android release '+manifest.apps.admin.versionName+' for source '+sourceCommit+' in '+output);
}
