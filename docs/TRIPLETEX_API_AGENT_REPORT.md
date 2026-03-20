# Tripletex API v2 — NM i AI 2026 (accounting agent)

**Base URL (sandbox):** `https://kkpqfuj-amager.tripletex.dev/v2`  
**OpenAPI 3.0.1:** fetched with `curl -s -k "https://kkpqfuj-amager.tripletex.dev/v2/openapi.json"` (~3.6 MB, 546 paths).  
**Auth (from spec `securitySchemes.tokenAuthScheme`):** HTTP Basic — username `0` (or company/customer id for proxy), password = session token.

This report is derived from that OpenAPI document. **Schemas rarely declare `required` arrays**; many business rules only appear in parameter `required` flags or descriptions. Treat the “runtime required” column as practical guidance for agents, not a guarantee the server never accepts partial data.

---

## Global patterns

| Topic | Detail |
|--------|--------|
| **Content-Type** | Most JSON bodies use `application/json; charset=utf-8`. Clients should send UTF-8 JSON. |
| **Reference objects** | Foreign keys are usually nested objects with at least `{ "id": <int64> }` (and on updates often `version`). Example: `"customer": { "id": 1 }`. |
| **Create payloads** | Descriptions say: *“Should not have ID and version set.”* |
| **Update payloads** | Typically full `PUT` with `id` + `version` (optimistic locking). |
| **Single GET by id** | `GET …/{id}?fields=` — optional `fields` filter pattern (default `""` or `*`). |
| **Search / list** | `GET` collection endpoints: pagination `from`, `count`, `sorting`, `fields`; many filters are comma-separated ID lists as **strings**. |
| **Responses** | Single entity: `ResponseWrapper*` with a `value` property. Lists: `ListResponse*` with `values`, `from`, `count`, `fullResultSize`, `versionDigest`. |

---

## Cross-resource reference map (high level)

Properties that point at **other API resources** (by schema `$ref`):

| Entity | References (main) |
|--------|-------------------|
| **Employee** | `department` → Department; `employments[]` → Employment; `address` → Address; `employeeCategory` → EmployeeCategory; `phoneNumberMobileCountry` → Country |
| **Customer** | `department` → Department; `accountManager` → Employee; `currency` → Currency; `ledgerAccount` → Account; addresses → Address / DeliveryAddress; `category1..3` → CustomerCategory |
| **Supplier** | Same pattern as customer (no `isCustomer` invoice fields); `ledgerAccount` → Account |
| **Product** | `vatType` → VatType; `currency` → Currency; `department` → Department; `account` → Account; `supplier` → Supplier; `productUnit` → ProductUnit; `discountGroup` → DiscountGroup |
| **Order** | `customer` → Customer; `department` → Department; `project` → Project; `currency` → Currency; `orderLines[]` → OrderLine; `ourContactEmployee` → Employee |
| **OrderLine** | `product` → Product; `order` → Order; `vatType` → VatType; `currency` → Currency |
| **Invoice** | `customer` → Customer; `orders[]` → Order; `orderLines[]` → OrderLine; `currency` → Currency; `voucher` → Voucher; `postings[]` → Posting |
| **TravelExpense** | `employee` → Employee; `department` → Department; `project` → Project; `vatType` → VatType; `paymentCurrency` → Currency; `voucher` → Voucher; `invoice` → Invoice; `costs[]` → Cost |
| **Cost** (travel line) | `travelExpense` → TravelExpense; `vatType` → VatType; `currency` → Currency; `costCategory` → TravelCostCategory; `paymentType` → TravelPaymentType |
| **Project** | `customer` → Customer; `department` → Department; `projectManager` → Employee; `vatType` → VatType; `currency` → Currency; `orderLines[]` → ProjectOrderLine |
| **Voucher** | `voucherType` → VoucherType; `postings[]` → Posting |
| **Posting** | `account` → Account; `customer` / `supplier` / `employee` / `project` / `product` / `department` → respective types; `vatType` → VatType; `currency` → Currency |

---

## 1. Employee (`/employee`)

| Method | Path | OperationId | Purpose |
|--------|------|-------------|---------|
| GET | `/employee` | `Employee_search` | Search/filter employees |
| POST | `/employee` | `Employee_post` | Create one employee |
| GET | `/employee/{id}` | `Employee_get` | Get by id |
| PUT | `/employee/{id}` | `Employee_put` | Update |
| POST | `/employee/list` | `EmployeeList_postList` | **Batch create** several employees |

### Request body (POST `/employee`, PUT `/employee/{id}`)

- **Schema:** `#/components/schemas/Employee`
- **No `required` array in schema** — server validates business rules.

**Notable properties**

| Property | Type | Notes / enums |
|----------|------|----------------|
| `firstName`, `lastName` | string | |
| `employeeNumber` | string | |
| `email` | string | |
| `userType` | string enum | `STANDARD`, `EXTENDED`, `NO_ACCESS` |
| `department` | Department | **FK** — set `department.id` |
| `employments` | Employment[] | **FK** — employment records |
| `address` | Address | |
| `isContact` | boolean | |

### Search GET `/employee` (query)

Includes `departmentId`, `employeeNumber`, `email`, `from`, `count`, `fields`, …

### Batch

- **`POST /employee/list`** — body: **`Employee[]`** (array). Summary: *“Create several employees.”*

---

## 2. Customer (`/customer`)

| Method | Path | OperationId |
|--------|------|-------------|
| GET | `/customer` | `Customer_search` |
| POST | `/customer` | `Customer_post` |
| GET | `/customer/{id}` | `Customer_get` |
| PUT | `/customer/{id}` | `Customer_put` |
| POST | `/customer/list` | `CustomerList_postList` |

**Body schema:** `Customer` — **no schema `required`**.

**FK-style fields:** `department`, `accountManager` (Employee), `currency`, `ledgerAccount` (Account), `category1..3` (CustomerCategory), addresses.

**Batch:** `POST /customer/list` — **`Customer[]`**. Marked **[BETA]** in spec.

---

## 3. Supplier (`/supplier`)

| Method | Path | OperationId |
|--------|------|-------------|
| GET | `/supplier` | `Supplier_search` |
| POST | `/supplier` | `Supplier_post` |
| GET | `/supplier/{id}` | `Supplier_get` |
| PUT | `/supplier/{id}` | `Supplier_put` |
| POST | `/supplier/list` | `SupplierList_postList` |

**Body:** `Supplier`. **FK:** `currency`, `ledgerAccount`, `accountManager`, categories, addresses.

**Batch:** `POST /supplier/list` — **`Supplier[]`**.

---

## 4. Product (`/product`)

| Method | Path | OperationId |
|--------|------|-------------|
| GET | `/product` | `Product_search` |
| POST | `/product` | `Product_post` |
| GET | `/product/{id}` | `Product_get` |
| PUT | `/product/{id}` | `Product_put` |
| POST | `/product/list` | `ProductList_postList` |

**Body:** `Product`.

**Important FK / accounting fields**

| Property | Ref |
|----------|-----|
| `vatType` | VatType |
| `currency` | Currency |
| `department` | Department |
| `account` | Account |
| `supplier` | Supplier |
| `productUnit` | ProductUnit |

**Batch:** `POST /product/list` — **`Product[]`**. Summary: *“Add multiple products.”*

---

## 5. Department (`/department`)

| Method | Path | OperationId |
|--------|------|-------------|
| GET | `/department` | `Department_search` |
| POST | `/department` | `Department_post` |
| GET | `/department/{id}` | `Department_get` |
| PUT | `/department/{id}` | `Department_put` |
| POST | `/department/list` | `DepartmentList_postList` |

**Body:** `Department` — properties include `name`, `departmentNumber`, `departmentManager` (**Employee**), `isInactive`, `businessActivityTypeId`.

**Batch:** `POST /department/list` — **`Department[]`**. *“Register new departments.”*

---

## 6. Invoice (`/invoice`)

| Method | Path | OperationId | Notes |
|--------|------|-------------|--------|
| GET | `/invoice` | `Invoice_search` | **Requires** `invoiceDateFrom`, `invoiceDateTo` (query) |
| POST | `/invoice` | `Invoice_post` | Create; optional `sendToCustomer`, `paymentTypeId`, `paidAmount` query |
| GET | `/invoice/{id}` | `Invoice_get` | |
| PUT | `/invoice/{id}` | `Invoice_put` | Update |
| POST | `/invoice/list` | `InvoiceList_postList` | **Batch create**, max **100**; **[BETA]** |
| PUT | `/invoice/{id}/:createCreditNote` | `InvoiceCreateCreditNote_createCreditNote` | Credit note |
| PUT | `/invoice/{id}/:send` | `InvoiceSend_send` | Send invoice |
| PUT | `/invoice/{id}/:payment` | `InvoicePayment_payment` | **Register payment** (not a separate `/payment` resource) |

### POST `/invoice` body — `Invoice`

**FK:** `customer`, `orders`, `orderLines`, `currency`, `voucher`, `postings`, etc.

**Enum:** `ehfSendStatus` on `Invoice`: `DO_NOT_SEND`, `SEND`, `SENT`, `SEND_FAILURE_RECIPIENT_NOT_FOUND`.

### GET `/invoice` required query

- `invoiceDateFrom`, `invoiceDateTo` — **required: true** in OpenAPI.

### Credit note — `PUT /invoice/{id}/:createCreditNote`

| Param | In | Required | Notes |
|-------|-----|----------|--------|
| `id` | path | yes | Invoice id |
| `date` | query | yes | Credit note date |
| `comment` | query | no | |
| `creditNoteEmail` | query | no | |
| `sendToCustomer` | query | no | default `true` |
| `sendType` | query | no | enum: `EMAIL`, `EHF`, `EFAKTURA`, `AVTALEGIRO`, `VIPPS`, `PAPER`, `MANUAL`, `DIRECT`, `AUTOINVOICE_EHF_OUTBOUND`, `AUTOINVOICE_EHF_INCOMING`, `PEPPOL_EHF_INCOMING` |

### Send — `PUT /invoice/{id}/:send`

| Param | Required | Enum |
|-------|----------|------|
| `sendType` | **yes** | `EMAIL`, `EHF`, `AVTALEGIRO`, `EFAKTURA`, `VIPPS`, `PAPER`, `MANUAL` |
| `overrideEmailAddress` | no | If `sendType=EMAIL` |

### Payment — `PUT /invoice/{id}/:payment` (this is the “payment create” for invoices)

| Param | Required | Description |
|-------|----------|-------------|
| `paymentDate` | **yes** | |
| `paymentTypeId` | **yes** | From `GET /invoice/paymentType` |
| `paidAmount` | **yes** | In payment type account currency |
| `paidAmountCurrency` | conditional | **Required for invoices in alternate currencies** (per description) |

**Related:** `GET /invoice/paymentType` — list payment types (`InvoicePaymentType_search`).

---

## 7. Order (`/order`)

| Method | Path | OperationId |
|--------|------|-------------|
| GET | `/order` | `Order_search` |
| POST | `/order` | `Order_post` |
| GET | `/order/{id}` | `Order_get` |
| PUT | `/order/{id}` | `Order_put` |
| POST | `/order/list` | `OrderList_postList` |

### GET `/order` — **required** query

- `orderDateFrom`, `orderDateTo` — **required: true**

### Body — `Order`

**Enum `status`:** `NOT_CHOSEN`, `NEW`, `CONFIRMATION_SENT`, `READY_FOR_PICKING`, `PICKED`, `PACKED`, `READY_FOR_SHIPPING`, `READY_FOR_INVOICING`, `INVOICED`, `CANCELLED`.

**FK:** `customer`, `department`, `project`, `currency`, `orderLines[]`, etc.

### Invoice from order — `PUT /order/{id}/:invoice`

| Param | Required | Notes |
|-------|----------|--------|
| `invoiceDate` | **yes** | |
| `sendToCustomer` | no | default `true` |
| `sendType` | no | `EMAIL`, `EHF`, `AVTALEGIRO`, `EFAKTURA`, `VIPPS`, `PAPER`, `MANUAL` |
| `paymentTypeId` / `paidAmount` | paired | Optional; both must be set if invoice already paid |
| `createOnAccount` | no | enum `NONE`, `WITH_VAT`, `WITHOUT_VAT` |

**Other:** `POST /order/:invoiceMultipleOrders` — invoice multiple orders in one call (see spec).

### Batch

- `POST /order/list` — **`Order[]`**, max **100** at a time **[BETA]**.
- `POST /order/orderline/list` — multiple order lines (`OrderOrderlineList_postList`).

---

## 8. Travel expense (`/travelExpense`)

There is **no** `GET /travelExpense/list` path; **listing is `GET /travelExpense`** (search).

| Method | Path | OperationId |
|--------|------|-------------|
| GET | `/travelExpense` | `TravelExpense_search` |
| POST | `/travelExpense` | `TravelExpense_post` |
| GET | `/travelExpense/{id}` | `TravelExpense_get` |
| PUT | `/travelExpense/{id}` | `TravelExpense_put` |
| DELETE | `/travelExpense/{id}` | `TravelExpense_delete` |
| POST | `/travelExpense/{travelExpenseId}/attachment` | `TravelExpenseAttachment_uploadAttachment` |
| POST | `/travelExpense/{travelExpenseId}/attachment/list` | `TravelExpenseAttachmentList_uploadAttachments` |

### GET `/travelExpense` — query `state` enum

`ALL`, `REJECTED`, `OPEN`, `APPROVED`, `SALARY_PAID`, `DELIVERED` (default `ALL`).

### Body — `TravelExpense`

**FK:** `employee`, `department`, `project`, `vatType`, `paymentCurrency`, `costs[]` → Cost, `travelDetails` → TravelDetails.

**Object state:** `TravelExpense.state` enum (same values as search filter).

### Receipt / file attachments

**Single file — `POST /travelExpense/{travelExpenseId}/attachment`**

- Content-Type: **`multipart/form-data`**
- **Required:** field **`file`** (binary)
- Query: `createNewCost` (boolean, default `false`) — *“Create new cost row when you add the attachment”*

**Multiple files — `POST /travelExpense/{travelExpenseId}/attachment/list`**

- `multipart/form-data` with **`file`** = array of binary (per spec)

### Vouchers from travel expense

- `PUT /travelExpense/:createVouchers` — query **`date`** required (`yyyy-MM-dd`); `id` = list of travel expense IDs.

---

## 9. Project (`/project`)

| Method | Path | OperationId |
|--------|------|-------------|
| GET | `/project` | `Project_search` |
| POST | `/project` | `Project_post` |
| GET | `/project/{id}` | `Project_get` |
| PUT | `/project/{id}` | `Project_put` |
| POST | `/project/list` | `ProjectList_postList` |

**Body:** `Project` — FK: `customer`, `department`, `projectManager` (Employee), `vatType`, `currency`, `orderLines`, etc.

**Batch:** `POST /project/list` — **`Project[]`** **[BETA]**.

---

## 10. Ledger — voucher (`/ledger/voucher`)

| Method | Path | OperationId |
|--------|------|-------------|
| GET | `/ledger/voucher` | `LedgerVoucher_search` |
| POST | `/ledger/voucher` | `LedgerVoucher_post` |
| GET | `/ledger/voucher/{id}` | `LedgerVoucher_get` |
| PUT | `/ledger/voucher/{id}` | `LedgerVoucher_put` |
| PUT | `/ledger/voucher/list` | `LedgerVoucherList_putList` | Batch **update** vouchers |

### GET `/ledger/voucher` — **required** query

- `dateFrom`, `dateTo` — **required: true**

### POST `/ledger/voucher` — body `Voucher`

- Query: `sendToLedger` (boolean, default `true`) — needs *“Advanced Voucher”* permission when true.
- Summary: *“Also creates postings. Only the gross amounts will be used. Amounts should be rounded to 2 decimals.”*

### `VoucherType` (important for agents)

Schema description: **Must not** use type *“Utgående faktura” (Outgoing Invoice)* on new vouchers — use **`voucherType`: null** or **`Invoice` endpoint** instead.

### `Voucher` → `postings[]` → `Posting`

Posting has `type` enum: `INCOMING_PAYMENT`, `INCOMING_PAYMENT_OPPOSITE`, `INCOMING_INVOICE_CUSTOMER_POSTING`, `INVOICE_EXPENSE`, `OUTGOING_INVOICE_CUSTOMER_POSTING`, `WAGE`.

**Supporting:** `GET /ledger/voucherType` — list voucher types (`LedgerVoucherType_search`).

---

## 11. Ledger — account (`/ledger/account`)

| Method | Path | OperationId |
|--------|------|-------------|
| GET | `/ledger/account` | `LedgerAccount_search` |
| POST | `/ledger/account` | `LedgerAccount_post` |
| POST | `/ledger/account/list` | `LedgerAccountList_postList` | Batch **create** accounts |
| PUT | `/ledger/account/list` | `LedgerAccountList_putList` | Batch **update** |

**Body:** `Account` — includes `number`, `type`, `ledgerType` enum on **search**: `GENERAL`, `CUSTOMER`, `VENDOR`, `EMPLOYEE`, `ASSET`, `vatType`, `currency`, `department`, etc.

---

## 12. Ledger — posting (`/ledger/posting`)

| Method | Path | OperationId |
|--------|------|-------------|
| GET | `/ledger/posting` | `LedgerPosting_search` |

### GET `/ledger/posting` — **required** query

- `dateFrom`, `dateTo` — **required: true** (`yyyy-MM-dd`; `dateTo` exclusive per description)

Optional filters: `accountId`, `customerId`, `supplierId`, `employeeId`, `departmentId`, `projectId`, `productId`, …

**Response:** list of `Posting` (via `ListResponsePosting` / similar — see spec).

---

## 13. Currency (`/currency`)

No separate `currency/list` path — **use `GET /currency`** (`Currency_search`).

**Query:** `id`, `code`, `from`, `count`, `sorting`, `fields`.

**Item schema:** `Currency` — `code`, `description`, `factor`, `isDisabled`, …

**Related:** exchange rate endpoints under `/currency/{fromCurrencyID}/…` (see spec).

---

## 14. VAT types (`/ledger/vatType`)

| Method | Path | OperationId |
|--------|------|-------------|
| GET | `/ledger/vatType` | `LedgerVatType_search` |
| GET | `/ledger/vatType/{id}` | `LedgerVatType_get` |

**Query `typeOfVat` enum:** `OUTGOING`, `INCOMING`, `INCOMING_INVOICE`, `PROJECT`, `LEDGER`.

**Query `vatDate`:** used with `typeOfVat` to return only types valid on that date.

**Schema:** `VatType` — `id`, `name`, `number`, `percentage`, `parentType`, …

---

## 15. “Payment” resource

There is **no** `POST /payment` in this spec for customer invoice payments.

**Use:** `PUT /invoice/{id}/:payment` (section 6) with `paymentTypeId` from `GET /invoice/paymentType`.

---

## Batch / list POST summary

| Endpoint | Body | Max / notes |
|----------|------|-------------|
| `POST /employee/list` | `Employee[]` | |
| `POST /customer/list` | `Customer[]` | [BETA] |
| `POST /supplier/list` | `Supplier[]` | |
| `POST /product/list` | `Product[]` | |
| `POST /department/list` | `Department[]` | |
| `POST /invoice/list` | `Invoice[]` | max **100**, [BETA] |
| `POST /order/list` | `Order[]` | max **100**, [BETA] |
| `POST /project/list` | `Project[]` | [BETA] |
| `POST /ledger/account/list` | `Account[]` | create several accounts |

**Note:** `/ledger/voucher/list` is **PUT** (batch update), not batch create.

---

## Competition workflows (patterns)

### A. Batch-create resources

Yes — for employees, customers, suppliers, products, departments, invoices, orders, projects via `POST …/list` where listed above. Payload is a **JSON array** of the entity schema.

### B. Customer → product → order → invoice

1. `POST /customer` (or batch) → customer `id`.
2. `POST /product` (with `vatType`, `currency`, `account`, … as needed).
3. `POST /order` with `customer: { id }`, `orderLines` with `product: { id }`, counts, prices, VAT.
4. Either:
   - **`PUT /order/{id}/:invoice`** with `invoiceDate`, optional `sendToCustomer` / `sendType`, or  
   - **`POST /invoice`** with nested `orders` / `orderLines` per `Invoice_post` summary (orders may be embedded as new objects).

### C. Send invoice

After `PUT /order/{id}/:invoice` or `POST /invoice`: **`PUT /invoice/{id}/:send`** with required `sendType`.

### D. Register payment on invoice

**`PUT /invoice/{id}/:payment`** with `paymentDate`, `paymentTypeId`, `paidAmount` (+ `paidAmountCurrency` if multi-currency).

### E. Travel expense with receipt

1. `POST /travelExpense` (body `TravelExpense`).
2. **`POST /travelExpense/{travelExpenseId}/attachment`** with `multipart/form-data` field **`file`** (binary); optional `createNewCost=true` to add a cost row from the receipt.

### F. Accounting corrections (vouchers)

- **`POST /ledger/voucher`** with `Voucher` and `postings[]` → creates postings; use `sendToLedger` query.
- **`POST /ledger/voucher`** with `voucherType` referencing **non–outgoing-invoice** types; use `GET /ledger/voucherType` to discover IDs.
- **Reverse:** `PUT /ledger/voucher/{id}/:reverse` (see spec for params).

### G. Credit notes

**`PUT /invoice/{id}/:createCreditNote`** with required `date` (and optional send flags). Returns `ResponseWrapperInvoice`.

---

## Appendix: `Employee.userType` enum

`STANDARD`, `EXTENDED`, `NO_ACCESS`

---

## Appendix: OpenAPI `required` query parameters (often missed by schema-only tools)

| Endpoint | Required query parameters |
|----------|---------------------------|
| `GET /invoice` | `invoiceDateFrom`, `invoiceDateTo` |
| `GET /order` | `orderDateFrom`, `orderDateTo` |
| `GET /ledger/voucher` | `dateFrom`, `dateTo` |
| `GET /ledger/posting` | `dateFrom`, `dateTo` |
| `PUT /invoice/{id}/:send` | `sendType` |
| `PUT /invoice/{id}/:payment` | `paymentDate`, `paymentTypeId`, `paidAmount` |
| `PUT /invoice/{id}/:createCreditNote` | `date` |
| `PUT /order/{id}/:invoice` | `invoiceDate` |
| `PUT /travelExpense/:createVouchers` | `date` |

---

*This document is generated from the Tripletex v2 OpenAPI JSON for sandbox `kkpqfuj-amager.tripletex.dev`. For authoritative behavior (422 validation, permissions, module flags), validate against the live sandbox and Tripletex documentation.*
