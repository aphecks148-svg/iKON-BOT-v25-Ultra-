const base='/data/user/0/com.androidharness.app/files/github-projects/iKON-BOT-v25-Ultra--b7fa1456';
const fs=require('fs');
const files=fs.readdirSync(base+'/commands').filter(f=>/^cmds_\d+\.js$/.test(f)).sort();
for(const f of files){const list=require(base+'/commands/'+f); console.log(f+': '+list.length);}
