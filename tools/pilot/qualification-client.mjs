import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HOST="127.0.0.1", GAME_PORT=25585, RCON_PORT=25595, USERNAME="PilotProbe";
const QUERY_FIELDS=["Pos","Dimension","Health"];
const sleepDefault=(ms)=>new Promise(r=>setTimeout(r,ms));
function finitePos(p){return p&&[p.x,p.y,p.z].every(Number.isFinite)?{x:p.x,y:p.y,z:p.z}:null}
function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)}
function parseReply(field,text){
 const prefix=`${USERNAME} has the following entity data: `;
 if(typeof text!=="string"||!text.startsWith(prefix)||Buffer.byteLength(text)>65536) throw new Error("invalid RCON response");
 const v=text.slice(prefix.length), n="[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
 if(field==="Pos"){const m=v.match(new RegExp(`^\\[(${n})d?,\\s*(${n})d?,\\s*(${n})d?\\]$`));if(!m)throw new Error("invalid position");const p={x:+m[1],y:+m[2],z:+m[3]};if(!finitePos(p))throw new Error("invalid position");return p}
 if(field==="Dimension"){const m=v.match(/^"(minecraft:(?:overworld|the_nether|the_end))"$/);if(!m)throw new Error("invalid dimension");return m[1]}
 const m=v.match(new RegExp(`^(${n})f?$`));if(!m||!Number.isFinite(+m[1]))throw new Error("invalid health");return +m[1]
}
async function bounded(factory,ms,label){let timer;try{return await Promise.race([Promise.resolve().then(factory),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timeout`)),ms)})])}finally{clearTimeout(timer)}}
async function waitSpawn(bot,ms){if(bot.entity)return;await bounded(()=>new Promise((resolve,reject)=>{bot.once("spawn",resolve);bot.once("error",reject);bot.once("kicked",reason=>reject(new Error(`kicked: ${String(reason).slice(0,128)}`)))}),ms,"bot spawn")}
async function observe(rcon){const out={};for(const field of QUERY_FIELDS){const command=`data get entity ${USERNAME} ${field}`;out[field]=parseReply(field,await rcon.send(command))}return {position:out.Pos,dimension:out.Dimension,health:out.Health}}
async function retryObserve(rcon,{deadlineMs,now,sleep}){let last;while(now()<deadlineMs){try{return await observe(rcon)}catch(e){last=e;await sleep(Math.min(250,Math.max(0,deadlineMs-now())))}}throw new Error(`server readiness failed: ${last?.message??"timeout"}`)}
export async function runQualification({createBot,connectRcon,writeEvidence,now=()=>Date.now(),sleep=sleepDefault,readyTimeoutMs=60000,actionMs=1000,operationTimeoutMs=5000}={}){
 if(typeof createBot!=="function"||typeof connectRcon!=="function"||typeof writeEvidence!=="function")throw new TypeError("qualification adapters required");
 for(const [n,v,max] of [["readyTimeoutMs",readyTimeoutMs,60000],["actionMs",actionMs,2000],["operationTimeoutMs",operationTimeoutMs,5000]])if(!Number.isInteger(v)||v<1||v>max)throw new RangeError(`invalid ${n}`);
 let bot,rcon,report={schemaVersion:1,status:"failed",claimsLiveBenchmarkResult:false,endpoint:{host:HOST,gamePort:GAME_PORT,rconPort:RCON_PORT},username:USERNAME};
 try{
  bot=await bounded(()=>createBot({host:HOST,port:GAME_PORT,username:USERNAME,auth:"offline"}),operationTimeoutMs,"bot create");
  await waitSpawn(bot,readyTimeoutMs);
  rcon=await bounded(()=>connectRcon({host:HOST,port:RCON_PORT}),operationTimeoutMs,"RCON connect");
  const before=await retryObserve(rcon,{deadlineMs:now()+readyTimeoutMs,now,sleep});
  const mineBefore=finitePos(bot.entity?.position);if(!mineBefore)throw new Error("Mineflayer position unavailable");
  bot.setControlState("forward",true);try{await sleep(actionMs)}finally{bot.setControlState("forward",false)}
  const after=await bounded(()=>observe(rcon),operationTimeoutMs,"after observation");
  const mineAfter=finitePos(bot.entity?.position);if(!mineAfter)throw new Error("Mineflayer position unavailable");
  const displacement=distance(before.position,after.position), agreement=distance(after.position,mineAfter);
  const passed=displacement>=0.5&&displacement<=10&&after.health>0&&before.dimension===after.dimension&&agreement<=1.5;
  report={...report,status:passed?"passed":"failed",before,after,mineflayer:{before:mineBefore,after:mineAfter},checks:{displacement,rconMineflayerDistance:agreement,healthPositive:after.health>0,dimensionUnchanged:before.dimension===after.dimension,displacementInBounds:displacement>=0.5&&displacement<=10,positionsAgree:agreement<=1.5}};
 }catch(e){report={...report,status:"failed",error:"qualification failed"}}finally{
  try{bot?.setControlState?.("forward",false)}catch{}
  try{await bounded(()=>bot?.quit?.("qualification complete"),1000,"bot quit")}catch{}
  try{await bounded(()=>rcon?.end?.(),1000,"RCON close")}catch{}
 }
 await writeEvidence(report);return report;
}
export function writePrivateEvidence(output,report){const fd=fs.openSync(output,"wx",0o600);try{fs.writeFileSync(fd,JSON.stringify(report,null,2)+String.fromCharCode(10))}finally{fs.closeSync(fd)}fs.chmodSync(output,0o600)}
async function main(){
 const {values}=parseArgs({options:{output:{type:"string"}}});if(!values.output)throw new Error("--output is required");if(!process.env.PILOT_RCON_PASSWORD)throw new Error("PILOT_RCON_PASSWORD is required");
 const [{createBot},{Rcon}]=await Promise.all([import("mineflayer"),import("rcon-client")]);
 const writeEvidence=async report=>writePrivateEvidence(values.output,report);
 const report=await runQualification({createBot,connectRcon:()=>Rcon.connect({host:HOST,port:RCON_PORT,password:process.env.PILOT_RCON_PASSWORD}),writeEvidence});process.exitCode=report.status==="passed"?0:1;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])main().catch(e=>{console.error(String(e?.message??e).slice(0,256));process.exitCode=1});