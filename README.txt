SOORI WASHING — VERSION 6
CAPTCHA + PENDING ORDER + WHATSAPP CONFIRMATION + ADMIN APPROVAL
================================================================

NEW ORDER FLOW
--------------
1. Customer completes Cloudflare Turnstile CAPTCHA.
2. The server verifies the CAPTCHA with Cloudflare BEFORE saving anything.
3. A valid order is saved to PostgreSQL with status: Pending.
4. The confirmation page shows:
   - Order number
   - Date/time
   - Preferred return date
   - Customer
   - Itemized services
   - Total
   - QR code
   - "Confirm Order on WhatsApp" button
5. The WhatsApp button opens a prepared message TO SOORI WASHING:
   +94 777400300
6. The customer presses Send in WhatsApp.
7. Staff verifies the received WhatsApp message.
8. In Admin, staff presses Approve.
9. The order status changes from Pending to Received.

IMPORTANT
---------
Clicking the WhatsApp button is recorded in the database, but this only proves the
button was clicked. It does NOT prove the customer pressed Send in WhatsApp.
The admin should verify that the WhatsApp message was actually received before Approve.

CLOUDFLARE TURNSTILE SETUP
--------------------------
Create a Turnstile widget in your Cloudflare account for your website hostname.

Then add these two variables in:
Render -> Soori Washing Web Service -> Environment

TURNSTILE_SITE_KEY
= your Cloudflare Turnstile site key

TURNSTILE_SECRET_KEY
= your Cloudflare Turnstile secret key

The SITE KEY is public and is delivered to the browser.
The SECRET KEY must remain private and is used only by server.js.

For local/testing only, Cloudflare's official always-pass test pair is:

TURNSTILE_SITE_KEY
1x00000000000000000000AA

TURNSTILE_SECRET_KEY
1x0000000000000000000000000000000AA

DO NOT use the testing keys for a public production website.

EXISTING RENDER ENVIRONMENT VARIABLES
-------------------------------------
DATABASE_URL = your Render PostgreSQL Internal Database URL
ADMIN_USER = your admin username
ADMIN_PASSWORD = your strong private password
SESSION_SECRET = your long random secret
NODE_ENV = production
PUBLIC_BASE_URL = https://YOUR-SITE.onrender.com

Optional:
BUSINESS_WHATSAPP = 94777400300

If BUSINESS_WHATSAPP is omitted, Version 6 defaults to:
94777400300

BUILD SETTINGS
--------------
Build Command:
npm install

Start Command:
npm start

DATABASE MIGRATION
------------------
No manual migration is required.

Version 6 automatically:
- keeps existing services and orders
- adds approved_at to orders if missing
- adds whatsapp_confirmation_clicked_at if missing
- changes the default status for NEW orders to Pending

Old existing orders are not changed automatically.

ADMIN PAGE
----------
/admin.html

Pending orders are shown first.

For each Pending order the admin can see:
- order details
- customer's phone number
- whether the WhatsApp confirmation button was clicked
- current status
- Approve button

Only press Approve after checking the actual WhatsApp message from the customer.

CAPTCHA TEST
------------
After deployment:
1. Open /api/health
2. Confirm:
   "captchaConfigured": true
3. Open /order.html
4. Confirm the Cloudflare verification box appears.
5. Try placing an order without completing CAPTCHA: it should not submit.
6. Complete CAPTCHA and place the order.
7. Confirm order status is Pending.
8. Press Confirm Order on WhatsApp.
9. Send the prepared WhatsApp message.
10. Log in to /admin.html.
11. Find the Pending order.
12. Verify the WhatsApp message.
13. Press Approve.
14. Track the order and confirm status is Received.

SECURITY IMPROVEMENTS IN VERSION 6
----------------------------------
- CAPTCHA is validated server-side.
- CAPTCHA is checked before database insertion.
- New online orders are not treated as confirmed immediately.
- Admin page route protection is placed before static-file serving.
- Final prices are still calculated from PostgreSQL, not trusted from the browser.
- WhatsApp confirmation goes to the Soori Washing business number.
- Admin approval is recorded with a timestamp.

BUSINESS
--------
Soori Washing
Kadawatha, Sri Lanka
+94 777400300
