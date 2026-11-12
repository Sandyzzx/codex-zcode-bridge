import {writeSync,readSync} from 'node:fs';
process.stderr.write('child_started\n');
writeSync(3,Buffer.from('ready\n'));
process.stderr.write('child_wrote\n');
const b=Buffer.alloc(16);const n=readSync(3,b,0,b.length,null);
process.stderr.write(`child_read_${n}\n`);
