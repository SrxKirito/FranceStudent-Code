const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "www");
const dst = path.join(__dirname, "android", "app", "src", "main", "assets", "public");

function copyDir(from, to, prefix) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const source = path.join(from, name);
    const target = path.join(to, name);
    const rel = prefix ? prefix + "/" + name : name;
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      copyDir(source, target, rel);
    } else if (stat.isFile()) {
      fs.copyFileSync(source, target);
      console.log("copié : " + rel);
    }
  }
}

copyDir(src, dst, "");
