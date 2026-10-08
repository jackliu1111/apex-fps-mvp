/* Native macOS build hook. The declared floor must follow the actual bundled load commands. */
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const magic=new Set(['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca']);
const version=value=>value.split('.').map(Number).concat([0,0,0]).slice(0,3);
function larger(left,right){const a=version(left),b=version(right);for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i]?left:right;}return left;}
function scan(roots){
 const began=Date.now(),seen=new Set(),native=[];
 const tool=execFileSync('/usr/bin/xcrun',['--find','vtool'],{encoding:'utf8',timeout:5000}).trim();
 const pending=[...roots];let visited=0;
 while(pending.length){
  if(Date.now()-began>120000||visited++>30000)throw Error('native minimum scan exceeded 120s/30000 entries');
  const file=pending.pop(),stat=fs.lstatSync(file);if(stat.isSymbolicLink())continue;
  if(stat.isDirectory()){pending.push(...fs.readdirSync(file).map(name=>path.join(file,name)));continue;}
  if(!stat.isFile())continue;
  const descriptor=fs.openSync(file,'r'),head=Buffer.alloc(4);try{fs.readSync(descriptor,head,0,4,0);}finally{fs.closeSync(descriptor);}
  if(!magic.has(head.toString('hex')))continue;
  const canonical=fs.realpathSync(file);if(seen.has(canonical))continue;seen.add(canonical);if(seen.size>500)throw Error('native minimum scan exceeded 500 Mach-O files');
  const text=execFileSync(tool,['-show-build',file],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
  const minima=[];
  for(const block of text.split(/Load command \d+/)){
   if(block.includes('cmd LC_BUILD_VERSION')){const platform=/\bplatform\s+(\S+)/.exec(block)?.[1],min=/\bminos\s+([\d.]+)/.exec(block)?.[1];if(['MACOS','1'].includes(platform)&&min)minima.push(min);}
   else if(block.includes('cmd LC_VERSION_MIN_MACOSX')){const min=/\bversion\s+([\d.]+)/.exec(block)?.[1];if(min)minima.push(min);}
  }
  native.push({file,macos_minima:minima});
 }
 const floors=native.flatMap(entry=>entry.macos_minima);if(!floors.length)throw Error('no macOS native load-command floor found; refusing guessed declaration');
 return{maximum_native_floor:floors.reduce(larger),native_count:native.length,native_entries:native,elapsed_ms:Date.now()-began,scope:'static macOS load-command floor, excludes SDK/iOS; lower-version runtime acceptance still required'};
}
module.exports=async context=>{
 if(context.electronPlatformName!=='darwin')return;
 const project=context.packager.projectDir;
 const configured=context.packager.config.electronDist;
 const electron=typeof configured==='string'?path.resolve(project,configured):path.join(project,'node_modules/electron/dist');
 if(!fs.existsSync(electron)||!fs.statSync(electron).isDirectory())throw Error('mac minimum derivation needs the actual unpacked Electron distribution');
 const resources=path.join(project,'resources'),report=scan([resources,electron]);
 const minimum=larger('13.0',report.maximum_native_floor);
 report.baseline_floor='13.0';report.declared_minimum=minimum;
 // beforePack runs before mac Info.plist is assembled; set both normalized and source config.
 context.packager.platformSpecificBuildOptions.minimumSystemVersion=minimum;
 context.packager.config.mac.minimumSystemVersion=minimum;
 fs.writeFileSync(path.join(resources,'macos-native-minimum.json'),JSON.stringify(report,null,2));
 const manifestPath=path.join(resources,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath));
 manifest.macos_minimum={baseline:'13.0',maximum_native_floor:report.maximum_native_floor,declared:minimum,scope:report.scope};
 fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2));
 console.log(`Derived macOS minimum ${minimum} from ${report.native_count} actual native binaries (static floor only)`);
};
