// Local feature verification with rtsai.net's layout on one origin: a static game build at /play/ and the website
// (sign-in, /api/event, /api/feedback) everywhere else.
// node tools/feature-preview.mjs [port=3494] [static-port=3493] [site=http://localhost:3475]
import http from 'node:http';
const port=Number(process.argv[2]||3494),upstream=Number(process.argv[3]||3493),site=new URL(process.argv[4]||'http://localhost:3475');
const server=http.createServer((req,res)=>{
 const game=req.url.startsWith('/play/');
 const target=game?{hostname:'127.0.0.1',port:upstream,path:req.url.slice(5)||'/'}:{hostname:site.hostname,port:site.port,path:req.url};
 const proxy=http.request({...target,method:req.method,headers:{...req.headers,host:game?`127.0.0.1:${upstream}`:site.host}},response=>{
  res.writeHead(response.statusCode,response.headers);response.pipe(res);
 });
 proxy.on('error',error=>{res.writeHead(502);res.end(error.message);});req.pipe(proxy);
});
server.listen(port,'127.0.0.1',()=>console.log(`Local feature preview http://127.0.0.1:${port}/play/ (game ${upstream}, site ${site.origin})`));
process.on('SIGINT',()=>server.close());
