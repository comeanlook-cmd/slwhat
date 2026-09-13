let services=[];
let turnstileToken="";
let turnstileWidgetId=null;
const money=n=>"LKR "+Number(n||0).toLocaleString("en-LK",{maximumFractionDigits:2});

function esc(s){return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}

async function waitForTurnstile(){
 for(let i=0;i<80;i++){
   if(window.turnstile)return true;
   await new Promise(r=>setTimeout(r,100));
 }
 return false;
}

async function setupCaptcha(){
 const box=document.getElementById("turnstile-box");
 const msg=document.getElementById("captcha-message");
 if(!box)return false;
 try{
   const r=await fetch("/api/public-config");
   const cfg=await r.json();
   if(!cfg.captchaConfigured||!cfg.turnstileSiteKey){
     box.innerHTML="<b>CAPTCHA is not configured.</b>";
     msg.textContent="Administrator: add TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY in Render Environment.";
     return false;
   }
   const ready=await waitForTurnstile();
   if(!ready){
     box.innerHTML="<b>Could not load CAPTCHA.</b>";
     msg.textContent="Please refresh the page and try again.";
     return false;
   }
   box.innerHTML='<div id="turnstile-widget"></div>';
   turnstileWidgetId=window.turnstile.render("#turnstile-widget",{
     sitekey:cfg.turnstileSiteKey,
     theme:"auto",
     callback:token=>{turnstileToken=token;msg.textContent="Security verification complete.";},
     "expired-callback":()=>{turnstileToken="";msg.textContent="CAPTCHA expired. Please complete it again.";},
     "error-callback":()=>{turnstileToken="";msg.textContent="CAPTCHA could not be completed. Please try again.";}
   });
   return true;
 }catch(e){
   box.innerHTML="<b>Could not load CAPTCHA.</b>";
   msg.textContent="Please refresh the page.";
   return false;
 }
}

async function setupOrder(){
 const box=document.getElementById("order-items");
 if(!box)return;

 setupCaptcha();

 try{
   const r=await fetch("/api/services");
   services=await r.json();
   if(!r.ok)throw new Error(services.error||"Could not load services");
 }catch(e){
   box.innerHTML="<p>Could not load service prices. Please refresh the page.</p>";
   return;
 }

 const cart={};
 const draw=()=>{
   box.innerHTML=services.map(s=>`<div class="price-row"><div><b>${esc(s.name)}</b><div class="muted">${money(s.price)} / ${esc(s.unit)}</div></div><div class="qty"><button type="button" data-m="${esc(s.id)}">−</button><b>${cart[s.id]||0}</b><button type="button" data-p="${esc(s.id)}">+</button></div></div>`).join("");
   box.querySelectorAll("[data-p]").forEach(b=>b.onclick=()=>{cart[b.dataset.p]=(cart[b.dataset.p]||0)+1;draw()});
   box.querySelectorAll("[data-m]").forEach(b=>b.onclick=()=>{cart[b.dataset.m]=Math.max(0,(cart[b.dataset.m]||0)-1);draw()});
   document.getElementById("order-total").textContent=money(services.reduce((a,s)=>a+(cart[s.id]||0)*Number(s.price),0));
 };
 draw();

 document.getElementById("order-form").onsubmit=async e=>{
   e.preventDefault();
   const f=new FormData(e.target);
   const items=services.filter(s=>cart[s.id]>0).map(s=>({serviceId:s.id,qty:cart[s.id]}));
   if(!items.length)return alert("Select at least one service.");
   if(!turnstileToken)return alert("Please complete the CAPTCHA before placing your order.");

   const btn=e.submitter||document.getElementById("place-order-btn");
   if(btn){btn.disabled=true;btn.textContent="Verifying & Saving..."}

   const payload={
     customerName:f.get("customerName"),phone:f.get("phone"),address:f.get("address"),
     pickupDate:f.get("pickupDate"),pickupTime:f.get("pickupTime"),deliveryDate:f.get("deliveryDate"),
     notes:f.get("notes"),paymentMethod:f.get("paymentMethod"),items,
     turnstileToken
   };

   let r,o;
   try{
     r=await fetch("/api/orders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
     o=await r.json();
   }catch(err){
     if(btn){btn.disabled=false;btn.textContent="Place Order"}
     return alert("Network error. Please try again.");
   }

   if(btn){btn.disabled=false;btn.textContent="Place Order"}

   if(!r.ok){
     turnstileToken="";
     if(window.turnstile&&turnstileWidgetId!==null)window.turnstile.reset(turnstileWidgetId);
     return alert(o.error||"Could not place order.");
   }

   e.target.classList.add("hidden");
   document.getElementById("done").classList.remove("hidden");
   document.getElementById("new-id").textContent=o.id;
   document.getElementById("confirmed-total").textContent=money(o.total);
   document.getElementById("confirmed-date").textContent=new Date(o.createdAt).toLocaleString();
   document.getElementById("confirmed-return").textContent=o.deliveryDate||"Not specified";
   document.getElementById("confirmed-name").textContent=o.customerName;
   document.getElementById("confirmed-status").textContent=o.status||"Pending";
   document.getElementById("qr-image").src=o.qrDataUrl;
   document.getElementById("qr-download").href=o.qrDataUrl;
   document.getElementById("qr-download").download=`${o.id}-QR.png`;
   document.getElementById("track-new").href=o.trackUrl||("/track.html?id="+encodeURIComponent(o.id));

   const wa=document.getElementById("whatsapp-confirm");
   if(o.whatsappUrl){
     wa.href=o.whatsappUrl;
     wa.classList.remove("hidden");
     wa.onclick=()=>{
       fetch("/api/orders/"+encodeURIComponent(o.id)+"/whatsapp-clicked",{method:"POST"}).catch(()=>{});
     };
   }

   window.scrollTo({top:document.getElementById("done").offsetTop-30,behavior:"smooth"});
 };
}
document.addEventListener("DOMContentLoaded",setupOrder);
