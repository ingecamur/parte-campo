/* Parte de campo · INGECAMUR
   Conexión con Dropbox (inicio de sesión PKCE, sin contraseñas guardadas) y cola de subidas
   que aguanta sin cobertura: todo se guarda en el móvil (IndexedDB) y se sube al volver la red. */
(function(){
"use strict";

// ====== CONFIGURACIÓN ======
// App key de la app registrada en https://www.dropbox.com/developers/apps (no es secreta).
var APP_KEY = "6qabc2s31kbr04c";
// Carpeta de la app en Dropbox: lista de trabajos, fichas de clientes y estado de los partes.
var CARPETA = "/AA 2026/AA CLAUDE/Parte de campo";
// ===========================

var LS = {
  get: function(k,d){ try{ var v=localStorage.getItem(k); return v==null?d:JSON.parse(v); }catch(e){ return d; } },
  set: function(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); return true; }catch(e){ return false; } },
  del: function(k){ try{ localStorage.removeItem(k); }catch(e){} }
};
var REDIRECT = location.origin + location.pathname.replace(/[^/]*$/,"");

// ---------- IndexedDB: cola de subidas y archivos locales (fotos, voces, CSV) ----------
var idbP = null;
function idb(){
  if(idbP) return idbP;
  idbP = new Promise(function(ok,ko){
    var r = indexedDB.open("parte-campo",1);
    r.onupgradeneeded = function(){ var d=r.result;
      if(!d.objectStoreNames.contains("cola")) d.createObjectStore("cola",{keyPath:"id",autoIncrement:true});
      if(!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs"); };
    r.onsuccess = function(){ ok(r.result); };
    r.onerror = function(){ ko(r.error); };
  });
  return idbP;
}
function tx(store,modo,fn){
  return idb().then(function(d){ return new Promise(function(ok,ko){
    var t=d.transaction(store,modo), s=t.objectStore(store), res; var r=fn(s);
    if(r) r.onsuccess=function(){ res=r.result; };
    t.oncomplete=function(){ ok(res); }; t.onerror=function(){ ko(t.error); }; t.onabort=function(){ ko(t.error); };
  }); });
}
var blobs = {
  put: function(k,b){ return tx("blobs","readwrite",function(s){ return s.put(b,k); }); },
  get: function(k){ return tx("blobs","readonly",function(s){ return s.get(k); }); },
  del: function(k){ return tx("blobs","readwrite",function(s){ return s.delete(k); }); }
};

// ---------- Sesión ----------
function b64url(buf){ var s="",a=new Uint8Array(buf); for(var i=0;i<a.length;i++) s+=String.fromCharCode(a[i]); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function aleatorio(n){ var a=new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
async function retoPKCE(){
  var v=aleatorio(48), h=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));
  LS.set("dbx-verifier",v); return b64url(h);
}
function configurada(){ return APP_KEY && APP_KEY.indexOf("PON_AQUI")<0; }
function conectado(){ return !!LS.get("dbx-refresh",null); }
async function urlLogin(conRedirect){
  var reto=await retoPKCE(), q={client_id:APP_KEY,response_type:"code",code_challenge:reto,code_challenge_method:"S256",token_access_type:"offline"};
  if(conRedirect) q.redirect_uri=REDIRECT;
  LS.set("dbx-con-redirect",!!conRedirect);
  return "https://www.dropbox.com/oauth2/authorize?"+new URLSearchParams(q).toString();
}
async function login(){ location.href=await urlLogin(true); }
async function canjear(code){
  var p={code:code.trim(),grant_type:"authorization_code",code_verifier:LS.get("dbx-verifier",""),client_id:APP_KEY};
  if(LS.get("dbx-con-redirect",false)) p.redirect_uri=REDIRECT;
  var r=await fetch("https://api.dropboxapi.com/oauth2/token",{method:"POST",body:new URLSearchParams(p)});
  var j=await r.json().catch(function(){return {};});
  if(!r.ok||!j.access_token) throw new Error(j.error_description||j.error||("HTTP "+r.status));
  guardarToken(j); LS.set("dbx-refresh",j.refresh_token); LS.del("dbx-verifier");
  await raiz(true); await cuenta();
  return true;
}
function guardarToken(j){ LS.set("dbx-token",{t:j.access_token,exp:Date.now()+((j.expires_in||14400)-120)*1000}); }
async function volverDeLogin(){
  var q=new URLSearchParams(location.search), c=q.get("code"), e=q.get("error_description")||q.get("error");
  if(!c&&!e) return null;
  history.replaceState(null,"",location.pathname+location.hash);
  if(e) return {error:e};
  try{ await canjear(c); return {ok:true}; }catch(x){ return {error:x.message}; }
}
var refrescando=null;
async function token(){
  var t=LS.get("dbx-token",null); if(t&&t.exp>Date.now()) return t.t;
  var rt=LS.get("dbx-refresh",null); if(!rt) throw {code:"sin_sesion"};
  if(!refrescando) refrescando=(async function(){
    var r=await fetch("https://api.dropboxapi.com/oauth2/token",{method:"POST",body:new URLSearchParams({grant_type:"refresh_token",refresh_token:rt,client_id:APP_KEY})});
    var j=await r.json().catch(function(){return {};});
    if(r.status===400||r.status===401){ if(/invalid_grant/.test(j.error||"")){ salir(); throw {code:"sin_sesion"}; } }
    if(!r.ok||!j.access_token) throw {code:"red",message:j.error||("HTTP "+r.status)};
    guardarToken(j); return j.access_token;
  })().finally(function(){ refrescando=null; });
  return refrescando;
}
function salir(){ ["dbx-token","dbx-refresh","dbx-raiz","dbx-cuenta"].forEach(LS.del); }

// Cuentas de equipo: trabajar desde la raíz del equipo para que las rutas «/AA 2026/…» sean las mismas que en el PC
async function raiz(forzar){
  var r=LS.get("dbx-raiz",null); if(r&&!forzar) return r;
  var j=await rpc("users/get_current_account",null,true);
  var ri=j.root_info||{}; r=(ri.root_namespace_id&&ri.root_namespace_id!==ri.home_namespace_id)?{id:ri.root_namespace_id}:{id:""};
  LS.set("dbx-raiz",r); LS.set("dbx-cuenta",{nombre:(j.name&&j.name.display_name)||"",email:j.email||""}); return r;
}
async function cuenta(){ return LS.get("dbx-cuenta",null); }
function asciiJSON(o){ return JSON.stringify(o).replace(/[\u007f-￿]/g,function(c){ return "\\u"+("000"+c.charCodeAt(0).toString(16)).slice(-4); }); }
async function cabeceras(sinRaiz){
  var h={Authorization:"Bearer "+await token()};
  if(!sinRaiz){ var r=await raiz(); if(r.id) h["Dropbox-API-Path-Root"]=asciiJSON({".tag":"root",root:r.id}); }
  return h;
}
async function pedir(url,mkInit,reintento){
  var r; try{ r=await fetch(url,await mkInit()); }catch(e){ if(e&&e.code) throw e; throw {code:"red",message:"sin conexión"}; }
  if(r.status===401&&!reintento){ LS.del("dbx-token"); return pedir(url,mkInit,true); }
  return r;
}
async function rpc(fn,body,sinRaiz){
  var r=await pedir("https://api.dropboxapi.com/2/"+fn,async function(){
    var h=await cabeceras(sinRaiz); if(body!=null) h["Content-Type"]="application/json";
    return {method:"POST",headers:h,body:body==null?null:JSON.stringify(body)}; });
  var txt=await r.text(), j; try{ j=JSON.parse(txt); }catch(e){ j={raw:txt}; }
  if(!r.ok) throw {code:r.status===409?"conflicto":r.status===429?"limite":"http_"+r.status,status:r.status,message:j.error_summary||txt.slice(0,200)};
  return j;
}
async function descargar(path,comoTexto){
  var r=await pedir("https://content.dropboxapi.com/2/files/download",async function(){
    var h=await cabeceras(); h["Dropbox-API-Arg"]=asciiJSON({path:path.normalize("NFC")}); return {method:"POST",headers:h}; });
  if(r.status===409) return null;
  if(!r.ok) throw {code:"http_"+r.status,status:r.status,message:(await r.text()).slice(0,200)};
  return comoTexto===false?r.blob():r.text();
}
async function subirYa(path,datos,modo){
  var cuerpo=typeof datos==="string"?new Blob([datos],{type:"text/plain;charset=utf-8"}):datos;
  var r=await pedir("https://content.dropboxapi.com/2/files/upload",async function(){
    var h=await cabeceras(); h["Content-Type"]="application/octet-stream";
    h["Dropbox-API-Arg"]=asciiJSON({path:path.normalize("NFC"),mode:modo==="add"?"add":"overwrite",autorename:modo==="add",mute:true});
    return {method:"POST",headers:h,body:cuerpo}; });
  var txt=await r.text(), j; try{ j=JSON.parse(txt); }catch(e){ j={}; }
  if(!r.ok) throw {code:r.status===429?"limite":"http_"+r.status,status:r.status,message:j.error_summary||txt.slice(0,200)};
  return j;
}
async function listarCarpeta(path){
  var out=[], j=await rpc("files/list_folder",{path:path.normalize("NFC"),recursive:false,limit:2000});
  out=out.concat(j.entries||[]);
  while(j.has_more){ j=await rpc("files/list_folder/continue",{cursor:j.cursor}); out=out.concat(j.entries||[]); }
  return out;
}

// ---------- Cola de subidas ----------
var oyentes=[], trabajando=false, ultimoError="";
function avisar(){ pendientes().then(function(n){ oyentes.forEach(function(f){ try{ f(n,ultimoError); }catch(e){} }); }); }
function alCambiar(f){ oyentes.push(f); avisar(); }
function pendientes(){ return tx("cola","readonly",function(s){ return s.count(); }).catch(function(){ return 0; }); }
// modo "overwrite" (resúmenes, partes .json, DXF) o "add" (fotos y voces: nunca pisa nada)
async function encolar(path,datos,modo,clave){
  var item={path:path,datos:datos,modo:modo||"overwrite",clave:clave||path,t:Date.now(),intentos:0};
  if(item.modo==="overwrite"){ // si ya había una versión pendiente del mismo archivo, la sustituye
    var viejos=await tx("cola","readonly",function(s){ return s.getAll(); });
    await Promise.all(viejos.filter(function(v){ return v.clave===item.clave; }).map(function(v){ return tx("cola","readwrite",function(s){ return s.delete(v.id); }); }));
  }
  await tx("cola","readwrite",function(s){ return s.add(item); });
  avisar(); procesar(); return true;
}
async function procesar(){
  if(trabajando||!conectado()||!configurada()) return;
  if(navigator.onLine===false){ ultimoError="sin cobertura"; avisar(); return; }
  trabajando=true;
  try{
    var items=await tx("cola","readonly",function(s){ return s.getAll(); });
    items.sort(function(a,b){ return a.id-b.id; });
    for(var i=0;i<items.length;i++){
      var it=items[i];
      try{
        var r=await subirYa(it.path,it.datos,it.modo);
        await tx("cola","readwrite",function(s){ return s.delete(it.id); });
        hechos.push({clave:it.clave,path:(r&&r.path_display)||it.path,t:Date.now()}); LS.set("dbx-hechos",hechos.slice(-300));
        ultimoError=""; avisar();
      }catch(e){
        if(e.code==="red"||e.code==="limite"||e.code==="sin_sesion"||/http_5/.test(e.code||"")){ ultimoError=e.code==="sin_sesion"?"hay que volver a entrar en Dropbox":e.code==="red"?"sin cobertura":"Dropbox ocupado, se reintenta"; avisar(); break; }
        it.intentos++; it.error=e.message||e.code;
        if(it.intentos>=5){ // error permanente: se aparta para no bloquear la cola, queda guardado en el móvil
          await tx("cola","readwrite",function(s){ return s.delete(it.id); });
          var fall=LS.get("dbx-fallidos",[]); fall.push({path:it.path,error:it.error,t:Date.now()}); LS.set("dbx-fallidos",fall.slice(-50));
          await blobs.put("fallido-"+it.t+"-"+it.path,it.datos);
        } else await tx("cola","readwrite",function(s){ return s.put(it); });
        ultimoError="no se pudo subir "+it.path.split("/").pop()+" ("+(e.message||e.code)+")"; avisar();
      }
    }
  } finally { trabajando=false; }
}
var hechos=LS.get("dbx-hechos",[]);
function subido(clave){ return hechos.some(function(h){ return h.clave===clave; }); }
addEventListener("online",function(){ ultimoError=""; procesar(); });
addEventListener("focus",procesar);
document.addEventListener("visibilitychange",function(){ if(!document.hidden) procesar(); });
setInterval(procesar,30000);

// ---------- Datos compartidos: trabajos, clientes y partes ----------
async function leerJSON(nombre){
  var t=await descargar(CARPETA+"/"+nombre); if(t==null) return null;
  try{ return JSON.parse(t); }catch(e){ throw {code:"json",message:nombre+" no es un JSON válido"}; }
}

// Sustituto de mcp.callTool("Dropbox", …) para el Editor DXF
var mcp = {
  callTool: async function(srv,fn,args){
    if(fn==="list_folder"){
      var e=await listarCarpeta(args.path||"");
      e=e.map(function(x){ return {name:x.name,path_display:x.path_display,object_type:x[".tag"]}; });
      if(args.object_types&&args.object_types.indexOf("folder")>-1&&args.object_types.length===1) e=e.filter(function(x){ return x.object_type==="folder"; });
      return {payload:{entries:e,has_more:false}};
    }
    if(fn==="create_folder") return {payload:{}};               // las subidas crean las carpetas solas
    if(fn==="create_file"){ await encolar(args.path,args.content,"overwrite"); return {payload:{}}; }
    throw {code:"no_soportado",message:fn};
  }
};

window.DBX = {
  CARPETA:CARPETA, configurada:configurada, conectado:conectado, login:login, urlLogin:urlLogin, canjear:canjear,
  volverDeLogin:volverDeLogin, salir:salir, cuenta:cuenta, descargar:descargar, leerJSON:leerJSON, listarCarpeta:listarCarpeta,
  encolar:encolar, procesar:procesar, pendientes:pendientes, alCambiar:alCambiar, subido:subido, blobs:blobs, mcp:mcp,
  fallidos:function(){ return LS.get("dbx-fallidos",[]); }
};
})();
