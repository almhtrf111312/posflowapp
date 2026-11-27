# PosFlow — Live test plan for an AI agent on an Android EMULATOR

> **For the testing agent (e.g. Antigravity).** Follow this file exactly, in order. The owner reads your report in Arabic;
> write the report in Arabic, keep test IDs, file names and numbers as they are.
> The app UI is Arabic: every button/label below is quoted **exactly** as it appears on screen («…»).
> You test on the **live production database**. Use ONLY the test accounts the owner gives you. Never use a real store.
> Never type passwords into this file or into the report.

---

## 0. FIRST: report your capabilities (before testing anything)

Before step 1, send the owner a short message (Arabic) answering each line with ✅ / ❌ and one sentence:

| # | Capability | How to check |
|---|---|---|
| C1 | Run shell commands on this computer | `node -v`, `npm -v`, `git --version` |
| C2 | Android SDK + emulator available | `adb version`, `emulator -list-avds` |
| C3 | Start an emulator and see/control its screen (tap, type, swipe) | start an AVD, take one screenshot |
| C4 | Build the Android app from source (Java 17/21 + Gradle) | `java -version`, see §1A |
| C5 | Install an APK on the emulator | `adb install` (see §1A) |
| C6 | Take screenshots to files | `adb exec-out screencap -p > test.png` |
| C7 | Turn the emulator network off/on | `adb shell cmd connectivity airplane-mode enable` / `disable` |
| C8 | Read the device clock (needed to time-stamp operations) | `adb shell date +%H:%M:%S` |

If C2, C3 or C5 is ❌ → use **§1B (web fallback)** and say clearly in the report which tests could not run natively.
Do not continue until the owner has seen this capability list.

---

## 1. Get the app running

### 1A. Preferred — build from source and install on the emulator
1. Get the code: `git clone https://github.com/almhtrf111312/posflowapp.git` (or `git pull` on `main` if already cloned). Use branch **`main`**.
2. Note the version: open `version.json` → write `versionName` and `versionCode` in the report.
3. `npm ci`
4. `npm run build`
5. `npx cap sync android`
6. `cd android && ./gradlew assembleDebug` (Windows: `gradlew.bat assembleDebug`). On failure, see `GRADLE_TROUBLESHOOTING.md`.
   - Do **not** add or change signing keys, `.env`, or any project file. If the build needs a missing secret, stop and report it.
7. Emulator: Android Studio → Device Manager → create **Pixel 7, Android 14 (API 34), Google APIs image**, RAM ≥ 4 GB. Start it.
8. Install: `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`.
   - If install fails with a signature conflict: `adb uninstall com.posflow.app`, then install again (on the emulator only).
9. Open the app. Accept the terms screen. Log in as the **owner test account**.

### 1B. Fallback — web build in a mobile-size browser (only if 1A is impossible)
`npm ci && npm run dev` → open the shown URL in Chrome, DevTools device toolbar **Pixel 7**. Native features (camera, printing,
file backup, status bar) cannot be tested this way: mark them **«لم يُختبر — بلا محاكي»**.

---

## 2. Setup (owner account) — do once, screenshot each
| ID | Step | Expected |
|---|---|---|
| S1 | Settings → currencies: enable **TRY** with rate **10** (only if no cashier shift is open; otherwise close shifts first) | Saved, no error |
| S2 | Settings → «المستخدمين»: the counter at the top | Counts cashiers only (the owner is not counted), e.g. «2 / 2 كاشير» |
| S3 | Cashier A → «تعديل»: «إلزام فتح وردية» ON, «السماح بالاسترداد» ON, «إمكانية إضافة المنتجات» OFF → «حفظ» | Saved; no «تعذّر تحديث صلاحية الاسترداد» |
| S4 | Cashier B → «تعديل»: «إلزام فتح وردية» OFF, «إضافة فواتير الموردين (المشتريات)» ON → «حفظ» | Saved |
| S5 | Page «الورديات»: card «الصندوق العام» → «عدّ الصندوق» → «تعبئة بالمبالغ المتوقعة» → «حفظ» | Toast «الصندوق مطابق» |
| S6 | «الصندوق العام» → «إيداع» 100 USD, then «إيداع» 500 TRY | Balance +100 USD; a line «500 TRY» under the balance |

---

## 3. Evidence rules (apply to EVERY test)
- Screenshot after each expected result: `adb exec-out screencap -p > shots/<ID>.png` (e.g. `shots/G3.png`). Several in one test: `G3a.png`, `G3b.png`.
- For every money operation write the **device time** (`adb shell date +%H:%M:%S`) in the report — the owner matches it to the database.
- Wait until the screen is stable (≥ 2 s) before the screenshot.
- If a result differs from **Expected**: screenshot, write exactly what you saw, continue with the next test
  — **except** when the test is marked **[BLOCKING]**: then stop that section and report.
- Never edit the code or the database to make a test pass.

---

## 4. Tests

### G — General drawer (owner, NO open shift)
| ID | Step | Expected |
|---|---|---|
| G1 | POS: cash sale of any product, total ≈ 10 USD | Sale succeeds; «الصندوق العام» balance +10 |
| G2 | Debts: pay 5 USD cash on an existing debt (no shift open) | Accepted (no «يتطلب وردية»); general drawer +5 |
| G3 | Expenses: add 20 USD expense | General drawer −20 |
| G4 | «الصندوق العام» → «التفاصيل» | Each movement once; debt payment shows «فاتورة <number>» only, no long codes |
| G5 | «عدّ الصندوق» → «تعبئة بالمبالغ المتوقعة» → change USD to 5 less → «حفظ» | Toast «عجز 5 USD»; drawer stays open |
| G6 | Sync log (sync icon in the header) | G1–G5 listed as «تمت المزامنة» |

### R — Shift requirement per cashier [BLOCKING for R1]
| ID | Step | Expected |
|---|---|---|
| R1 | Log in as **cashier A** (shift required), no shift: try a CASH sale | Refused: «يجب فتح وردية قبل البيع» |
| R2 | Cashier A, no shift: try a DIGITAL sale | Refused with the same message |
| R3 | Cashier A, no shift: try a CREDIT (آجل) sale | Refused with the same message |
| R4 | Log in as **cashier B** (not required), no shift: cash sale 3 USD | Accepted; owner sees general drawer +3 |
| R5 | Cashier A: try to open «الدعم الفني» / contact | Not visible anywhere |

### W — Cashier shifts managed by the owner
| ID | Step | Expected |
|---|---|---|
| W1 | Owner: «فتح وردية لكاشير» → cashier A, opening 20 USD + 300 TRY | Shift opened; general drawer −20 USD and −300 TRY |
| W2 | Cashier A device/session: open «الورديات» | Open shift shows opening 20 USD and 300 TRY |
| W3 | Cashier A: cash sale 15 USD; credit sale 30 USD | Both succeed |
| W4 | Owner: «التفاصيل» next to cashier A's shift | Invoices: cash 15, credit (ديون) 30; drawer movements listed |
| W5 | Owner: close cashier A's shift counting 35 USD + 300 TRY | Closed; general drawer +35 USD +300 TRY |
| W6 | Repeat W1, then cashier A closes the shift counting 20 USD less than expected | Difference deferred; owner sees «لديك 1 فرق ورديات بانتظار قرارك» on next app start |

### E — Expenses
| ID | Step | Expected |
|---|---|---|
| E1 | Owner opens own shift. Expense 50 USD, field «يُدفع من» = «الصندوق العام» | Taken from general drawer, not from the shift |
| E2 | Fixed (recurring) expense: auto-pay ON, due today, every 17 days | Paid automatically within ~20 s of opening the app, once only |

### P — Permissions
| ID | Step | Expected |
|---|---|---|
| P1 | Cashier A (no «إمكانية إضافة المنتجات»): Products → tap a product name | Toast «لا تملك صلاحية تعديل المنتجات»; no edit form |
| P2 | Cashier A: sell normally (with a shift) | Sale works (stock decreases) |
| P3 | Cashier B (purchases ON): open «المشتريات», choose a supplier, finish a purchase invoice | Supplier list visible; invoice finalized |
| P4 | Owner: Users → cashier A → toggle «السماح بالاسترداد» → «حفظ» | Saved («تم منح/حجب صلاحية الاسترداد») |

### I — Invoices screen
| ID | Step | Expected |
|---|---|---|
| I1 | Open «الفواتير» | No «مبيعات هذا الأسبوع» row; three (owner: four) small tiles in ONE row; list shows this week |
| I2 | «التصفية» → period «الشهر» then «الكل» | List changes accordingly |
| I3 | Share a partly-paid credit invoice paid in TRY → WhatsApp text and image | «المدفوع … (دُفع بـ TRY)», no exchange rate |

### D — Products screen (all three view buttons)
| ID | Step | Expected |
|---|---|---|
| D1 | Open «المنتجات» | No separate «إجمالي / متوفر / منخفض» row; «النشطة» has a small arrow |
| D2 | Tap «النشطة» (already selected) | Menu: النشطة / متوفر / مخزون منخفض with counts; choosing filters the list |
| D3 | Categories | ONE row, scrolls sideways, most-used first, «متعدد الوحدات» in the same row; «المزيد» shows all with no gaps |
| D4 | Large view (first button) | No barcode on the card; stock badge on the bottom of the image |
| D5 | Middle view (list) | Buy/sell boxes fully inside the card (nothing cut at the bottom) |
| D6 | Open a product and leave without changing anything | No «إلغاء التعديلات والخروج؟» question |

### U — Layout / status bar
| ID | Step | Expected |
|---|---|---|
| U1 | Purchases → new purchase invoice | Header (steps 1/2/3) starts BELOW the status bar (clock/battery not over it) |
| U2 | Any long dialog (e.g. «تعديل المستخدم») | Title below the status bar |

### O — Offline (emulator airplane mode)
| ID | Step | Expected |
|---|---|---|
| O1 | Owner, no shift: airplane mode ON → cash sale 4 USD + expense 2 USD → airplane mode OFF, wait 30 s | Both appear once in the sync log and in the general drawer |
| O2 | Airplane ON: open the app pages (debts, reports, invoices) | Open instantly from saved data |

### B — Backup (native only)
| ID | Step | Expected |
|---|---|---|
| B1 | Settings → backup → back up now | Saved to `Documents/PosFlow App`; file exists (`adb shell ls "/sdcard/Documents/PosFlow App"`) |
| B2 | «النسخ المحفوظة على الجهاز» → «استعادة» | Restore works without the system file picker |

---

## 5. Report format (Arabic, one file `REPORT.md` + folder `shots/`)
1. **Capabilities** (§0 table, ✅/❌).
2. **Build**: method (1A or 1B), `versionName`/`versionCode`, emulator model/Android version, any build problem.
3. **Results table**:

| ID | النتيجة ✅/❌/لم يُختبر | المتوقع | الذي ظهر فعلاً | وقت الجهاز | الصورة |
|---|---|---|---|---|---|

4. **Failures in detail**: for each ❌, the exact steps, the message on screen word for word, the screenshot name.
5. **Not tested and why** (e.g. camera, printing, Google login on an emulator).

Send `REPORT.md` and the `shots/` folder to the owner. Do not change any code, settings file or database row yourself.
