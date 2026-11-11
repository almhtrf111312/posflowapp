# FlowPOS Pro - Master Native Android Migration Plan (Kotlin + Jetpack Compose)

**Target Stack:** 100% Native Android  
**Language:** Kotlin  
**UI Framework:** Jetpack Compose (Material 3)  
**Architecture:** Clean Architecture + MVI/MVVM + Hilt + Coroutines/Flow  
**Local Persistence:** Room Database (SQLite) + Preferences DataStore  
**Status Date:** 2026-11-12  

---

## 1. Stack Equivalence Blueprint

| Category | Source (React / TypeScript / Capacitor) | Target (100% Native Android) | Status |
| :--- | :--- | :--- | :--- |
| **Language & Runtime** | TypeScript 5.8 / Node 20 | Kotlin 2.1 / JVM 17 | `[ ] Pending` |
| **UI Framework** | React 18 + Tailwind CSS + Lucide Icons | Jetpack Compose (Material 3) + Compose Icons | `[ ] Pending` |
| **Design & Theme** | Tailwind Classes (`bg-background`, `text-primary`) | `FlowPosTheme` (Color.kt, Type.kt, Shape.kt) | `[ ] Pending` |
| **Directionality** | CSS `dir="rtl"` (Arabic First) | Compose `LocalLayoutDirection provides LayoutDirection.Rtl` | `[ ] Pending` |
| **State Management** | React Hooks (`useState`, `useEffect`, Custom Hooks) | `ViewModel` + `StateFlow` + `SharedFlow` | `[ ] Pending` |
| **Dependency Injection**| Custom React Providers (`CloudSyncProvider`, etc.) | Google Dagger Hilt (`@HiltViewModel`, `@Singleton`) | `[ ] Pending` |
| **Local Storage** | Capacitor SQLite + Dexie.js (`local_products`, etc.) | AndroidX Room Database (`@Entity`, `@Dao`) | `[ ] Pending` |
| **Key-Value Store** | `localStorage` / `@capacitor/preferences` | AndroidX Preferences DataStore | `[ ] Pending` |
| **Networking & Cloud** | `@supabase/supabase-js` + Fetch API | Supabase Kotlin SDK + OkHttp 4 / Retrofit 2 | `[ ] Pending` |
| **Navigation** | `react-router-dom` (URL-based routes) | Jetpack Navigation Compose (Type-safe Kotlin Routes) | `[ ] Pending` |
| **Thermal Printing** | Web Serial / Bluetooth / Custom Capacitor plugins | Native Android Bluetooth Classic Socket & USB Host (ESC/POS) | `[ ] Pending` |
| **Barcode Scanning** | `@capacitor-mlkit/barcode-scanning` | CameraX + Google ML Kit Barcode Scanning SDK | `[ ] Pending` |
| **Biometric Auth** | `@aparajita/capacitor-biometric-auth` | AndroidX `BiometricPrompt` | `[ ] Pending` |
| **Local Notifications**| `@capacitor/local-notifications` | AndroidX `NotificationManagerCompat` + WorkManager | `[ ] Pending` |

---

## 2. Recommended `libs.versions.toml` Dependencies

```toml
[versions]
agp = "8.8.0"
kotlin = "2.1.0"
compose-bom = "2024.12.01"
hilt = "2.53.1"
room = "2.6.1"
navigation = "2.8.5"
datastore = "1.1.1"
camera = "1.4.1"
mlkit-barcode = "17.3.0"
biometric = "1.2.0-alpha05"
supabase = "3.1.0"
ktor = "3.0.3"
kotlinx-serialization = "1.7.3"
coroutines = "1.10.1"

[libraries]
androidx-compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "compose-bom" }
androidx-compose-ui = { group = "androidx.compose.ui", name = "ui" }
androidx-compose-material3 = { group = "androidx.compose.material3", name = "material3" }
androidx-compose-preview = { group = "androidx.compose.ui", name = "ui-tooling-preview" }
androidx-navigation-compose = { group = "androidx.navigation", name = "navigation-compose", version.ref = "navigation" }

# Room
androidx-room-runtime = { group = "androidx.room", name = "room-runtime", version.ref = "room" }
androidx-room-compiler = { group = "androidx.room", name = "room-compiler", version.ref = "room" }
androidx-room-ktx = { group = "androidx.room", name = "room-ktx", version.ref = "room" }

# Hilt
hilt-android = { group = "com.google.dagger", name = "hilt-android", version.ref = "hilt" }
hilt-compiler = { group = "com.google.dagger", name = "hilt-android-compiler", version.ref = "hilt" }
androidx-hilt-navigation-compose = { group = "androidx.hilt", name = "hilt-navigation-compose", version = "1.2.0" }

# Hardware & Peripherals
androidx-camera-core = { group = "androidx.camera", name = "camera-core", version.ref = "camera" }
androidx-camera-camera2 = { group = "androidx.camera", name = "camera-camera2", version.ref = "camera" }
androidx-camera-lifecycle = { group = "androidx.camera", name = "camera-lifecycle", version.ref = "camera" }
androidx-camera-view = { group = "androidx.camera", name = "camera-view", version.ref = "camera" }
google-mlkit-barcode = { group = "com.google.mlkit", name = "barcode-scanning", version.ref = "mlkit-barcode" }
androidx-biometric = { group = "androidx.biometric", name = "biometric", version.ref = "biometric" }
```

---

## 3. Phased Sequential Migration Gates

### Phase 0: Discovery & Architecture Blueprint
- [x] Scan `package.json`, `src/types/index.ts`, `src/lib/db/schema.ts`, and all page routes.
- [x] Map database tables (`local_products`, `local_invoices`, `local_invoice_items`, `local_customers`).
- [x] Define migration protocols and agent swarm roles.
- [x] Generate `migration_tracker/MIGRATION_PLAN.md`.
- **Status:** **COMPLETED** (Waiting for human approval to proceed to Phase 1).

---

### Phase 1: Native Project Foundation, Gradle Setup & Design System
- [ ] Initialize clean Native Android Gradle configuration (`app/build.gradle.kts`, `libs.versions.toml`).
- [ ] Build Material 3 Design System matching FlowPOS Pro dark/light palette:
  - `Color.kt` (Primary, Secondary, Background, Surface, Accents, Error, Success).
  - `Type.kt` (Noto Sans Arabic typography scales).
  - `Theme.kt` with RTL support (`LocalLayoutDirection provides LayoutDirection.Rtl`).
  - Common Composables: `FlowPosButton`, `FlowPosTextField`, `FlowPosCard`, `FlowPosDialog`, `FlowPosTopBar`.
- [ ] Port assets (icons, splash drawables, localization strings to `res/values/strings.xml` and `res/values-ar/strings.xml`).
- [ ] Run `./gradlew assembleDebug` to verify baseline compilation.

---

### Phase 2: Local Persistence & Core Data Layer (Room + DataStore)
- [ ] Implement Room Entities:
  - `ProductEntity` (mapped from `local_products`).
  - `InvoiceEntity` (mapped from `local_invoices`).
  - `InvoiceItemEntity` (mapped from `local_invoice_items`).
  - `CustomerEntity` (mapped from `local_customers`).
  - `ShiftEntity`, `ExpenseEntity`, `PartnerEntity`.
- [ ] Implement Room DAOs with reactive Kotlin `Flow` queries and suspend mutation functions.
- [ ] Implement `FlowPosDatabase` with TypeConverters (JSON fields, Date, Enums).
- [ ] Implement `PreferencesDataStore` for active license cache, device binding, and POS settings.
- [ ] Verification Gate: Room unit tests and compiler symbol checks.

---

### Phase 3: Auth, Shell, Security & Navigation
- [ ] Port Navigation Graph (Type-Safe Routes via Kotlin Serialization):
  - `Route.Login`, `Route.Signup`, `Route.PinLock`, `Route.Pos`, `Route.Products`, `Route.Invoices`, `Route.Reports`, `Route.Settings`, `Route.BossPanel`.
- [ ] Implement `AppLockOverlay` & `MandatoryPinSetupModal` in Compose.
- [ ] Implement `Sidebar` and adaptive layout (Tablet/POS landscape vs. Mobile portrait).
- [ ] Implement `LicenseGuard` and device-binding checks in native Kotlin.
- [ ] Verification Gate: Navigate between auth, lock, and main shell without crashes.

---

### Phase 4: Core POS & Product Management
- [ ] POS Screen (`POSScreen.kt`):
  - Category selector tabs with horizontal scroll.
  - Product grid with search filter and quick barcode scanner button.
  - Cart panel: quantity adjusters, box vs. piece toggle, unit price adjustments.
  - Quick checkout dialog: Cash, Debt, Multi-currency (USD, SYP, TRY) calculation.
  - Hold / Suspend invoices drawer.
- [ ] Products Management (`ProductsScreen.kt`):
  - Product list with lazy loading and search.
  - Add / Edit product dialog with barcode auto-generation, custom fields, and photo picker.
  - Enforcement of license product limit (`ProductLimitsUseCase`).
- [ ] Verification Gate: Add 5 products, add to cart, and complete a sale into Room DB.

---

### Phase 5: Operations, Accounting & Reports
- [ ] Cash Shifts (`CashShiftsScreen.kt`): Open shift, record cash-in/out, close shift with discrepancy reporting.
- [ ] Invoices & Tracking (`InvoicesScreen.kt`, `InvoiceTrackingScreen.kt`): Search, view invoice details, refund items.
- [ ] Customers & Debts (`CustomersScreen.kt`, `DebtsScreen.kt`): Customer directory, debt settlement, statement export.
- [ ] Expenses & Services (`ExpensesScreen.kt`, `ServicesScreen.kt`).
- [ ] Reports & Analytics (`ReportsScreen.kt`): Daily closing report, profit trends, partner profit distribution.
- [ ] Verification Gate: Complete full operational cycle: Open shift ➔ Sale ➔ Expense ➔ Close shift ➔ Daily report.

---

### Phase 6: Hardware Bridges, Boss Panel & Distribution Build
- [ ] Native Thermal Printer Engine (`FlowPosThermalPrinter`):
  - Bluetooth Classic printer discovery and RFCOMM socket connection.
  - USB Host printer discovery and bulk transfer.
  - Native ESC/POS Arabic text rasterization (Canvas to monochrome bitmap) for flawless Arabic printing without broken letters.
- [ ] Camera Barcode Scanner via CameraX + ML Kit with continuous scan mode.
- [ ] Biometric Auth integration for quick cashier unlock.
- [ ] Boss Panel (`BossPanelScreen.kt`): Plan management, subscription activations, live support chat.
- [ ] Final Build Verification: Production APK release (`assembleRelease`) with ProGuard/R8 optimization.
