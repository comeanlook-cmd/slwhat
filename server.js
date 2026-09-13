const express=require("express");
const path=require("path");
const crypto=require("crypto");
const QRCode=require("qrcode");
const {Pool}=require("pg");

const app=express();
const PORT=process.env.PORT||3000;
const ADMIN_USER=process.env.ADMIN_USER||"";
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";
const SESSION_SECRET=process.env.SESSION_SECRET||"";
const DATABASE_URL=process.env.DATABASE_URL||"";
const PUBLIC_BASE_URL=(process.env.PUBLIC_BASE_URL||"").replace(/\/$/,"");
const TURNSTILE_SITE_KEY=process.env.TURNSTILE_SITE_KEY||"";
const TURNSTILE_SECRET_KEY=process.env.TURNSTILE_SECRET_KEY||"";
const BUSINESS_WHATSAPP=(process.env.BUSINESS_WHATSAPP||"94777400300").replace(/\D/g,"");

const pool=new Pool({
  connectionString:DATABASE_URL,
  ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false
});

app.set("trust proxy",1);
app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:true}));

function makeId(){
  return "SW-"+new Date().toISOString().slice(0,10).replaceAll("-","")+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();
}
function parseCookies(req){
  const h=req.headers.cookie||"";
  return Object.fromEntries(h.split(";").map(x=>x.trim()).filter(Boolean).map(p=>{
    const i=p.indexOf("=");
    if(i<0)return [decodeURIComponent(p),""];
    return [decodeURIComponent(p.slice(0,i)),decodeURIComponent(p.slice(i+1))];
  }));
}
function sign(v){return crypto.createHmac("sha256",SESSION_SECRET).update(v).digest("hex")}
function makeToken(u){
  const payload=Buffer.from(JSON.stringify({u,exp:Date.now()+28800000})).toString("base64url");
  return payload+"."+sign(payload);
}
function valid(t){
  if(!t||!SESSION_SECRET)return false;
  const a=t.split("."); if(a.length!==2)return false;
  const s1=Buffer.from(a[1]),s2=Buffer.from(sign(a[0]));
  if(s1.length!==s2.length||!crypto.timingSafeEqual(s1,s2))return false;
  try{
    const d=JSON.parse(Buffer.from(a[0],"base64url").toString("utf8"));
    return d.u===ADMIN_USER&&d.exp>Date.now();
  }catch{return false}
}
function configured(){return !!(ADMIN_USER&&ADMIN_PASSWORD&&SESSION_SECRET&&DATABASE_URL)}
function auth(req,res,next){
  if(!configured())return res.status(503).json({error:"Server is not fully configured."});
  if(!valid(parseCookies(req).soori_admin))return res.status(401).json({error:"Authentication required."});
  next();
}
function money(n){return "LKR "+Number(n||0).toLocaleString("en-LK",{maximumFractionDigits:2})}
function publicBase(req){return PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`}
function clientIp(req){
  const forwarded=String(req.headers["x-forwarded-for"]||"").split(",")[0].trim();
  return forwarded||req.ip||req.socket?.remoteAddress||"";
}

async function verifyTurnstile(token,ip){
  if(!TURNSTILE_SECRET_KEY)return {success:false,error:"CAPTCHA is not configured on the server."};
  if(!token)return {success:false,error:"Please complete the CAPTCHA."};

  try{
    const body=new URLSearchParams();
    body.set("secret",TURNSTILE_SECRET_KEY);
    body.set("response",String(token));
    if(ip)body.set("remoteip",ip);

    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),10000);
    const response=await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",{
      method:"POST",
      headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body,
      signal:controller.signal
    });
    clearTimeout(timer);
    const result=await response.json();
    return result.success
      ? {success:true}
      : {success:false,error:"CAPTCHA verification failed. Please try again.",codes:result["error-codes"]||[]};
  }catch(e){
    console.error("Turnstile validation error:",e.message);
    return {success:false,error:"CAPTCHA verification is temporarily unavailable. Please try again."};
  }
}

async function initDB(){
  await pool.query(`CREATE TABLE IF NOT EXISTS services(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'item',
    price NUMERIC(12,2) NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS orders(
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'Pending',
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT,
    pickup_date TEXT,
    pickup_time TEXT,
    delivery_date TEXT,
    notes TEXT,
    payment_method TEXT,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    total NUMERIC(12,2) NOT NULL DEFAULT 0
  )`);

  // Safe migrations for databases created by earlier versions.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS whatsapp_confirmation_clicked_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'Pending'`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_services_sort ON services(sort_order)`);

  const defaults=[
    ["wash","Wash & Dry","kg",150,1],
    ["shirt","Dry Cleaning – Shirt","item",350,2],
    ["trouser","Dry Cleaning – Trousers","item",450,3],
    ["suit","Wedding Suit Dry Cleaning","item",0,4],
    ["iron","Ironing / Pressing","item",0,5],
    ["bedding","Bedding / Comforter","item",0,6]
  ];
  for(const s of defaults){
    await pool.query(`INSERT INTO services(id,name,unit,price,sort_order)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,s);
  }
}

/* Admin page route MUST come before express.static so admin.html itself is protected. */
app.get("/admin.html",(req,res)=>{
  if(valid(parseCookies(req).soori_admin))
    return res.sendFile(path.join(__dirname,"public","admin.html"));
  res.redirect("/admin-login.html");
});

app.use(express.static(path.join(__dirname,"public")));

app.get("/api/health",async(req,res)=>{
  try{
    const r=await pool.query("SELECT NOW() now");
    res.json({
      ok:true,database:"connected",time:r.rows[0].now,
      captchaConfigured:Boolean(TURNSTILE_SITE_KEY&&TURNSTILE_SECRET_KEY)
    });
  }catch(e){res.status(500).json({ok:false,database:"disconnected",error:e.message})}
});

app.get("/api/public-config",(req,res)=>{
  res.json({
    turnstileSiteKey:TURNSTILE_SITE_KEY,
    captchaConfigured:Boolean(TURNSTILE_SITE_KEY&&TURNSTILE_SECRET_KEY),
    businessWhatsApp:BUSINESS_WHATSAPP
  });
});

app.get("/api/services",async(req,res)=>{
  try{
    const r=await pool.query(`SELECT id,name,unit,price,active,sort_order FROM services WHERE active=TRUE ORDER BY sort_order,name`);
    res.json(r.rows.map(s=>({...s,price:Number(s.price)})));
  }catch(e){res.status(500).json({error:"Could not load services."})}
});

app.get("/api/admin/configured",(req,res)=>res.json({configured:configured()}));
app.post("/api/admin/login",(req,res)=>{
  if(!configured())return res.status(503).json({error:"Set DATABASE_URL, ADMIN_USER, ADMIN_PASSWORD and SESSION_SECRET."});
  const u=String(req.body.username||""),p=String(req.body.password||"");
  const okU=u.length===ADMIN_USER.length&&crypto.timingSafeEqual(Buffer.from(u),Buffer.from(ADMIN_USER));
  const okP=p.length===ADMIN_PASSWORD.length&&crypto.timingSafeEqual(Buffer.from(p),Buffer.from(ADMIN_PASSWORD));
  if(!okU||!okP)return res.status(401).json({error:"Invalid username or password"});
  const secure=process.env.NODE_ENV==="production"?"; Secure":"";
  res.setHeader("Set-Cookie",`soori_admin=${encodeURIComponent(makeToken(u))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure}`);
  res.json({ok:true});
});
app.post("/api/admin/logout",(req,res)=>{
  const secure=process.env.NODE_ENV==="production"?"; Secure":"";
  res.setHeader("Set-Cookie",`soori_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
  res.json({ok:true});
});
app.get("/api/admin/me",(req,res)=>res.json({authenticated:valid(parseCookies(req).soori_admin)}));

app.get("/api/admin/services",auth,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT id,name,unit,price,active,sort_order,updated_at FROM services ORDER BY sort_order,name`);
    res.json(r.rows.map(s=>({...s,price:Number(s.price)})));
  }catch(e){res.status(500).json({error:"Could not load services."})}
});

app.patch("/api/admin/services/:id",auth,async(req,res)=>{
  const price=Number(req.body.price);
  if(!Number.isFinite(price)||price<0)return res.status(400).json({error:"Price must be zero or greater."});
  const name=String(req.body.name||"").trim();
  const unit=String(req.body.unit||"").trim();
  const active=Boolean(req.body.active);
  if(!name||!unit)return res.status(400).json({error:"Service name and unit are required."});
  try{
    const r=await pool.query(`UPDATE services SET name=$1,unit=$2,price=$3,active=$4,updated_at=NOW() WHERE id=$5 RETURNING *`,
      [name,unit,price,active,String(req.params.id)]);
    if(!r.rows.length)return res.status(404).json({error:"Service not found."});
    res.json({...r.rows[0],price:Number(r.rows[0].price)});
  }catch(e){res.status(500).json({error:"Could not save service."})}
});

app.post("/api/orders",async(req,res)=>{
  const b=req.body||{};

  // CAPTCHA is checked BEFORE anything is written to PostgreSQL.
  const captcha=await verifyTurnstile(b.turnstileToken,clientIp(req));
  if(!captcha.success)return res.status(400).json({error:captcha.error||"CAPTCHA verification failed."});

  const client=await pool.connect();
  try{
    if(!b.customerName||!b.phone||!Array.isArray(b.items)||!b.items.length)
      return res.status(400).json({error:"Name, phone and at least one service are required."});

    const requested=new Map();
    for(const item of b.items){
      const sid=String(item.serviceId||item.id||"");
      const qty=Math.max(0,Math.min(999,Number(item.qty)||0));
      if(sid&&qty>0)requested.set(sid,(requested.get(sid)||0)+qty);
    }
    if(!requested.size)return res.status(400).json({error:"Select at least one valid service."});

    await client.query("BEGIN");
    const ids=[...requested.keys()];
    const sr=await client.query(`SELECT id,name,unit,price FROM services WHERE active=TRUE AND id=ANY($1::text[])`,[ids]);
    if(sr.rows.length!==ids.length){
      await client.query("ROLLBACK");
      return res.status(400).json({error:"One or more selected services are unavailable."});
    }

    let total=0;
    const items=sr.rows.map(s=>{
      const qty=requested.get(s.id);
      const unitPrice=Number(s.price);
      const lineTotal=qty*unitPrice;
      total+=lineTotal;
      return {serviceId:s.id,service:s.name,qty,unit:s.unit,unitPrice,lineTotal};
    }).sort((a,b)=>ids.indexOf(a.serviceId)-ids.indexOf(b.serviceId));

    const id=makeId();
    const r=await client.query(
      `INSERT INTO orders(id,status,customer_name,phone,address,pickup_date,pickup_time,delivery_date,notes,payment_method,items,total)
       VALUES($1,'Pending',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       RETURNING id,status,created_at`,
      [id,String(b.customerName).slice(0,120),String(b.phone).slice(0,50),String(b.address||"").slice(0,500),
       String(b.pickupDate||"").slice(0,30),String(b.pickupTime||"").slice(0,30),String(b.deliveryDate||"").slice(0,30),
       String(b.notes||"").slice(0,1000),String(b.paymentMethod||"").slice(0,100),
       JSON.stringify(items),total]
    );
    await client.query("COMMIT");

    const created=r.rows[0].created_at;
    const trackUrl=`${publicBase(req)}/track.html?id=${encodeURIComponent(id)}`;
    const details=[
      "SOORI WASHING ORDER",
      `Order: ${id}`,
      `Customer: ${String(b.customerName).slice(0,120)}`,
      `Order date/time: ${new Date(created).toISOString()}`,
      `Preferred return date: ${String(b.deliveryDate||"Not specified")}`,
      ...items.map(x=>`${x.service}: ${x.qty} × ${money(x.unitPrice)} = ${money(x.lineTotal)}`),
      `Total: ${money(total)}`,
      "Status: Pending - waiting for WhatsApp confirmation and admin approval",
      `Track: ${trackUrl}`
    ].join("\n");

    const qrDataUrl=await QRCode.toDataURL(details,{errorCorrectionLevel:"M",margin:2,width:360});

    // Customer confirms by messaging the BUSINESS, not their own number.
    const whatsappText=[
      "Hello Soori Washing,",
      "I would like to confirm my online laundry order.",
      `Order: ${id}`,
      `Customer: ${String(b.customerName).slice(0,120)}`,
      `Customer phone: ${String(b.phone).slice(0,50)}`,
      `Order date/time: ${new Date(created).toLocaleString("en-LK",{timeZone:"Asia/Colombo"})}`,
      `Preferred return: ${String(b.deliveryDate||"Not specified")}`,
      ...items.map(x=>`${x.service}: ${x.qty} × ${money(x.unitPrice)} = ${money(x.lineTotal)}`),
      `Total: ${money(total)}`,
      "Please confirm this order.",
      `Track: ${trackUrl}`
    ].join("\n");

    const whatsappUrl=BUSINESS_WHATSAPP
      ? `https://wa.me/${BUSINESS_WHATSAPP}?text=${encodeURIComponent(whatsappText)}`
      : "";

    res.status(201).json({
      id,status:"Pending",createdAt:created,total,items,
      customerName:String(b.customerName),deliveryDate:String(b.deliveryDate||""),
      qrDataUrl,whatsappUrl,whatsappText,trackUrl
    });
  }catch(e){
    try{await client.query("ROLLBACK")}catch{}
    console.error(e);
    res.status(500).json({error:"Could not save order."});
  }finally{client.release()}
});

/* Records that the customer clicked the WhatsApp confirmation button.
   This does NOT claim they actually pressed Send in WhatsApp. */
app.post("/api/orders/:id/whatsapp-clicked",async(req,res)=>{
  try{
    const r=await pool.query(
      `UPDATE orders SET whatsapp_confirmation_clicked_at=COALESCE(whatsapp_confirmation_clicked_at,NOW()),updated_at=NOW()
       WHERE LOWER(id)=LOWER($1) AND status='Pending'
       RETURNING id,whatsapp_confirmation_clicked_at`,
      [String(req.params.id)]
    );
    if(!r.rows.length)return res.status(404).json({error:"Pending order not found."});
    res.json({ok:true,clickedAt:r.rows[0].whatsapp_confirmation_clicked_at});
  }catch(e){res.status(500).json({error:"Could not record confirmation action."})}
});

app.get("/api/orders/:id",async(req,res)=>{
  try{
    const r=await pool.query(`SELECT id,created_at,status,customer_name,phone,items,total,pickup_date,delivery_date,approved_at
      FROM orders WHERE LOWER(id)=LOWER($1) LIMIT 1`,[String(req.params.id)]);
    if(!r.rows.length)return res.status(404).json({error:"Order not found."});
    const o=r.rows[0];
    res.json({
      id:o.id,createdAt:o.created_at,status:o.status,customerName:o.customer_name,phone:o.phone,
      items:o.items,total:Number(o.total||0),pickupDate:o.pickup_date,deliveryDate:o.delivery_date,
      approvedAt:o.approved_at
    });
  }catch(e){res.status(500).json({error:"Could not retrieve order."})}
});

app.get("/api/admin/orders",auth,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT * FROM orders ORDER BY
      CASE WHEN status='Pending' THEN 0 ELSE 1 END,
      created_at DESC`);
    res.json(r.rows.map(o=>({
      id:o.id,createdAt:o.created_at,updatedAt:o.updated_at,status:o.status,
      customerName:o.customer_name,phone:o.phone,address:o.address,pickupDate:o.pickup_date,pickupTime:o.pickup_time,
      deliveryDate:o.delivery_date,notes:o.notes,paymentMethod:o.payment_method,items:o.items,total:Number(o.total||0),
      approvedAt:o.approved_at,whatsappConfirmationClickedAt:o.whatsapp_confirmation_clicked_at
    })));
  }catch(e){res.status(500).json({error:"Could not load orders."})}
});

/* Explicit approval: Pending -> Received */
app.post("/api/admin/orders/:id/approve",auth,async(req,res)=>{
  try{
    const r=await pool.query(
      `UPDATE orders SET status='Received',approved_at=NOW(),updated_at=NOW()
       WHERE LOWER(id)=LOWER($1) AND status='Pending'
       RETURNING id,status,approved_at`,
      [String(req.params.id)]
    );
    if(!r.rows.length)return res.status(409).json({error:"Order is not pending or was not found."});
    res.json(r.rows[0]);
  }catch(e){res.status(500).json({error:"Could not approve order."})}
});

app.patch("/api/admin/orders/:id/status",auth,async(req,res)=>{
  const allowed=["Pending","Received","Picked Up","Washing","Dry Cleaning","Ironing","Quality Check","Ready","Out for Delivery","Delivered","Cancelled"];
  if(!allowed.includes(req.body.status))return res.status(400).json({error:"Invalid status."});
  try{
    const approved=req.body.status==="Received"
      ? ", approved_at=COALESCE(approved_at,NOW())"
      : "";
    const r=await pool.query(
      `UPDATE orders SET status=$1,updated_at=NOW()${approved}
       WHERE LOWER(id)=LOWER($2) RETURNING id,status,approved_at`,
      [req.body.status,String(req.params.id)]
    );
    if(!r.rows.length)return res.status(404).json({error:"Order not found."});
    res.json(r.rows[0]);
  }catch(e){res.status(500).json({error:"Could not update order."})}
});

app.delete("/api/admin/orders/:id",auth,async(req,res)=>{
  try{
    const r=await pool.query(`DELETE FROM orders WHERE LOWER(id)=LOWER($1) RETURNING id`,[String(req.params.id)]);
    if(!r.rows.length)return res.status(404).json({error:"Order not found."});
    res.json({ok:true,id:r.rows[0].id});
  }catch(e){res.status(500).json({error:"Could not delete order."})}
});

app.get("/api/admin/export.csv",auth,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT id,created_at,customer_name,phone,status,total,approved_at,whatsapp_confirmation_clicked_at
      FROM orders ORDER BY created_at DESC`);
    const esc=v=>`"${String(v??"").replaceAll('"','""')}"`;
    const rows=[
      ["Order ID","Created","Customer","Phone","Status","Total","Approved At","WhatsApp Button Clicked At"],
      ...r.rows.map(o=>[o.id,o.created_at,o.customer_name,o.phone,o.status,o.total,o.approved_at,o.whatsapp_confirmation_clicked_at])
    ];
    res.setHeader("Content-Type","text/csv; charset=utf-8");
    res.setHeader("Content-Disposition","attachment; filename=soori-orders.csv");
    res.send(rows.map(x=>x.map(esc).join(",")).join("\n"));
  }catch(e){res.status(500).json({error:"Could not export orders."})}
});

initDB()
  .then(()=>app.listen(PORT,()=>console.log(`Soori Washing V6 running at http://localhost:${PORT}`)))
  .catch(e=>{console.error("Database initialization failed:",e);process.exit(1)});
