// Local feature verification: proxy a static preview and provide ephemeral room APIs.
// node tools/feature-preview.mjs [port=3494] [static-port=3493]
import http from 'node:http';
import {createRooms} from '../server/rooms.mjs';
const rooms=createRooms();
const port=Number(process.argv[2]||3494),upstream=Number(process.argv[3]||3493);
const server=http.createServer((req,res)=>{
 if(req.url==='/api/multiplayer'&&req.method==='POST')return void rooms.handle(req,res);
 const proxy=http.request({hostname:'127.0.0.1',port:upstream,path:req.url,method:req.method,headers:req.headers},response=>{
  res.writeHead(response.statusCode,response.headers);response.pipe(res);
 });
 proxy.on('error',error=>{res.writeHead(502);res.end(error.message);});req.pipe(proxy);
});
server.listen(port,'127.0.0.1',()=>console.log(`Local feature preview http://127.0.0.1:${port} → ${upstream}`));
process.on('SIGINT',()=>{rooms.close();server.close();});
