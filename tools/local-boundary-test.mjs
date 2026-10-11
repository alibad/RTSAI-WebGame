import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
const port = Number(process.env.RTSAI_TEST_PORT || 3507);
function request(path, method, headers) { return new Promise((resolve,reject) => { const req=http.request({host:'127.0.0.1',port,path,method,headers},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end(method==='POST'?'{}':undefined); }); }
const paths=['/api/health','/api/companion/status','/api/companion/start','/api/companion/stop','/companion/api/v1/state','/companion/api/v1/proposals/confirm','/api/maps/library'];
let rejected=0;
for (const path of paths) for (const headers of [{Host:`127.0.0.1:${port}`,Origin:'https://foreign.invalid'},{Host:`127.0.0.1:${port}`,Origin:'null'},{Host:`127.0.0.1:${port+1}`},{Host:`foreign.invalid:${port}`}]) { const response=await request(path,/start|stop|confirm/.test(path)?'POST':'GET',headers);assert.equal(response.status,403,`${path} ${JSON.stringify(headers)}`);rejected++; }
assert.equal((await request('/api/health','GET',{Host:`127.0.0.1:${port}`,Origin:`http://127.0.0.1:${port}`})).status,200);
for (const origin of ['https://foreign.invalid','null',undefined]) { const response=await new Promise(resolve=>{const socket=net.connect(port,'127.0.0.1');let data='';socket.on('connect',()=>socket.write(`GET /companion/bridge HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${origin?`Origin: ${origin}\r\n`:''}\r\n`));socket.on('data',chunk=>data+=chunk);socket.on('close',()=>resolve(data));socket.on('error',()=>resolve(data));setTimeout(()=>{socket.destroy();resolve(data);},2000).unref();});assert.ok(!response.includes('101 Switching'),String(response)); }
for (const headers of [
  `Host: 127.0.0.1:${port}\r\nHost: foreign.invalid:${port}\r\n`,
  `Host: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nOrigin: https://foreign.invalid\r\n`,
]) {
  const response=await new Promise(resolve=>{const socket=net.connect(port,'127.0.0.1');let data='';socket.on('connect',()=>socket.write(`GET /api/health HTTP/1.1\r\n${headers}Connection: close\r\n\r\n`));socket.on('data',chunk=>data+=chunk);socket.on('close',()=>resolve(data));socket.on('error',()=>resolve(data));});
  assert.match(response,/HTTP\/1\.1 403/);
}
const status=await request('/api/companion/status','GET',{Host:`127.0.0.1:${port}`});assert.equal(JSON.parse(status.body).running,false);
console.log(JSON.stringify({passed:true,foreignHTTPRejected:rejected,foreignOrMissingWebSocketOriginRejected:3,ambiguousHeadersRejected:2,noCompanionStarted:true}));
