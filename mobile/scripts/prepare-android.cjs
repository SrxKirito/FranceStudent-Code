const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
function cap(...args) {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/@capacitor/cli/bin/capacitor'), ...args], {cwd:root, stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!fs.existsSync(path.join(root, 'android'))) cap('add', 'android');
const java = path.join(root, 'android/app/src/main/java/org/francestudent/chat');
fs.mkdirSync(java, {recursive:true});
for (const name of ['MainActivity.java','IDELinkVaultPlugin.java','QRScannerPlugin.java']) fs.copyFileSync(path.join(root,'android-native',name), path.join(java,name));
const gradle = path.join(root, 'android/app/build.gradle');
let text = fs.readFileSync(gradle,'utf8');
if (!text.includes('play-services-code-scanner')) text += "\ndependencies { implementation 'com.google.android.gms:play-services-code-scanner:16.1.0' }\n";
fs.writeFileSync(gradle,text);
cap('sync','android');
console.log('Android préparé : scanner QR et coffre AndroidKeyStore enregistrés.');
