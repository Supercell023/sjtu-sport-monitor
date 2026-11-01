# SJTU Sports Venue Monitor

A Tampermonkey userscript for [sports.sjtu.edu.cn](https://sports.sjtu.edu.cn) that watches the booking grid for cancellations and claims the freed slot before anyone else does.

Gyms and courts at SJTU are released at **12:00 daily for the 7th day ahead** and are gone within seconds. But people also cancel — and a cancelled slot silently reappears in the grid, usually at a random moment. This script polls for exactly that: it watches the venues you care about, tells you the instant something frees up, and — if you don't take it yourself within a few minutes — books it for you and pushes the payment link to your phone.

> **Status:** verified end-to-end against a real account. Two real bookings were placed and then cancelled during testing.

---

## Why a userscript

The obvious approach is a background Python daemon. That does not work here, and the reason is worth knowing:

- The site authenticates with `JSESSIONID` — **HttpOnly and session-scoped**, so it lives only in the browser's memory and is never written to disk. Reading the cookie database or exporting cookies gets you the jAccount cookie and nothing else.
- Replaying the jAccount OAuth flow with only the persisted `JATrustCookie` fails: the server bounces straight to the login page. The jAccount session itself is also in-memory.
- The browser is therefore the **only** place a valid session exists — so the script has to run inside it. A userscript does exactly that, with same-origin requests carrying the session for free.

The booking request also matters. `ConfirmOrder` takes an AES-encrypted body plus RSA-encrypted `sid` / `tim` headers. Rather than reimplementing that (and risking a mismatch with a future build), the script borrows the page's own `Aes` / `Rsa` objects off the Vue root instance — **byte-identical to what the site itself sends when you click 提交订单**.

---

## Features

- **Multi-target watching** — any venue × sport × date × time slot combination; date and slot lists default to "all", so one target can cover a whole week.
- **Two modes**
  - *Notify-first* (default): alert on a hit, wait *N* minutes (default 5), re-check, and book only if the slot is still free — you always get first refusal.
  - *Book-immediately*: for the slots you will not tolerate losing.
- **Layered alerts** — full-width pulsing banner, blinking tab title, looping chime, desktop notification, plus optional phone push.
- **Auto-open the payment page** after booking, and remind you again at the 5- and 10-minute marks.
- **Stops itself** once every target has been booked.
- **Survives a page refresh** — monitoring resumes automatically.
- **Backs off politely** — jittered interval, 90 s default, and it never hammers the API.

---

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Edge / Chrome / Firefox).
2. Open the Tampermonkey dashboard → **Create a new script** → paste the whole of `sjtu-sport-monitor.user.js` → **Ctrl/Cmd + S**.
3. Visit `https://sports.sjtu.edu.cn/pc/` and log in. A red 🎯 button appears in the bottom-right corner.

> **Chromium 137+ / Edge:** userscripts are blocked until you explicitly allow them. Go to `edge://extensions` → Tampermonkey → **Details** → turn on **Allow User Scripts**, then reload the page. If the button never appears, this is almost always why.

---

## Usage

Open the panel with the 🎯 button, then:

1. Pick a **venue**, a **sport**, the **dates** (next 8 days) and the **time slots**. Leaving dates or slots empty means "all of them".
2. **Add target**. Repeat for every combination you want watched.
3. Choose the mode and the polling interval.
4. **Start**. "试跑一次" (dry run) checks once and reports what it finds without booking.

---

## Notifications

On the desktop, four things fire together the moment a slot frees up:

1. A full-width **red banner** across the top of the page — it pulses, and stays until dismissed.
2. The **tab title blinks** `发现空位...`, visible from any other tab.
3. A **looping chime** every 2.6 s for up to three minutes.
4. A native **desktop notification**.

To get alerts on your phone, paste a webhook address into the notifications section — the script detects the service from the URL:

| Phone | Service | Address |
|---|---|---|
| iPhone | **Bark** (recommended) | App Store → Bark → copy the `https://api.day.app/xxxx` string from its home screen |
| Android | **ntfy** | Install ntfy, subscribe to a topic you invent, use `https://ntfy.sh/your-topic` |
| WeChat | Server酱 | sct.ftqq.com → copy `https://sctapi.ftqq.com/SCTxxxx.send` |
| WeCom / Feishu | Group bot | Copy the bot's webhook URL from the group settings |

Paste with or without `< >` and quotes — the script strips them. Click **test push** and check your phone; every push logs its HTTP result, so a broken address is never silent. Booking confirmations include a tappable payment link.

---

## Verified behaviour

- Slot detection on a live account — `status == 0` and `count > 0`.
- Automatic booking — two real orders placed (`1102786553446666240`, `1102794770130145280`), both cancelled afterwards.
- Payment link retrieval via `orderImmediatelyPC`.
- Cancellation via `/tRefundReceipt/tRefundReceipt/createUserReceipt`.
- No CAPTCHA involved.

⚠️ Cancelling **after** the payment order has been created leaves the order in 退款受理中 (refund pending) rather than cleanly cancelled. Normal use never hits this — you pay instead of cancelling.

---

## Disclaimer

**Read this before using it.**

The venue user agreement is explicit:

> 严禁使用"外挂"或其他手段预约场地，一经发现，加入黑名单，取消预约场地权限。

*Using "plug-ins" or any other means to book venues is strictly forbidden; offenders will be blacklisted and lose booking privileges.*

This tool does exactly what that sentence describes. It is not official, it is not sanctioned, and it is not undetectable — from the server's side it looks like unusually regular requests followed by a same-second booking. **You use it at your own risk, and the consequences are yours.**

Related rules worth knowing:

- Cancellations are limited: venues marked 紧张 / 很紧张 (which includes most gyms) allow **at most 5 cancellations per 7 days**.
- No-shows are punished harder — a second one within six months means a one-month ban; a third means the blacklist.
- An unpaid booking auto-cancels **15 minutes** after the payment page is opened. **If it books for you, go pay.**

The author does not encourage breaking these rules and accepts no liability for blacklisting, lost booking privileges, or anything else that follows.

---

## Limitations

- **Your computer has to stay on** with the tab open. The script runs in the browser, not on a server — phone push removes the need to watch the screen, not the need for a live browser.
- **Background tabs are throttled.** Browsers slow timers in hidden tabs (to roughly once a minute after five minutes), so keep the tab pinned or in its own window.
- If the site ever starts demanding a slider CAPTCHA, the script reports it and stops rather than fighting it.
- PC pages only (`/pc/`).
- The encryption layer depends on the page's own Vue instance; a major front-end rewrite may require updating.

---

## Project layout

| File | Notes |
|---|---|
| `sjtu-sport-monitor.user.js` | The userscript |
| `docs/api-notes.md` | Reverse-engineered endpoints, encryption, status codes (Chinese) |
| `docs/panel.png`, `docs/alert-hit.png` | Screenshots |
| `README.zh-CN.md` | Chinese documentation |

---

MIT licensed. Not affiliated with Shanghai Jiao Tong University.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
