# Payments: MINT (Supplier)

| Step | Actions | System | Expected Result | Decision / Rule | Evidence Screenshot |
|---|---|---|---|---|---|
| 1 | Travel consultant searches via Booking number in Tramada and click to view the Booking (e.g. 13061) | Tramada | Lands on Booking Summary page | | |
| 2 | Click "Payments" under Booking Transaction on the left nav panel | Tramada | Lands on Booking Payments page | | |
| 3 | Dropdown at top right should be "Creditor Payment", click "Add/Issue Payment" button | Tramada | Lands on Issue Creditor Payment page | | |
| 4 | Transaction Type field, select "EFT" from dropdown | Tramada | | | |
| 5 | Payment To field, select Supplier name from dropdown | Tramada | | | |
| 6 | Use the information under Segments to Allocate to pay the supplier.<br><br>Reference number is found in the text under the column "Reference".<br><br>Amount to pay is found under the "Creditor Payable" column | Tramada | | | Screenshot: "Issue Creditor Payment" page in Tramada, showing Payment Overview, Payment Details, Delivery Details, Payment Notes, and Segments to Allocate sections |
| 7 | (See MintEFT screens below) | MintEFT | | | Screenshots: MintEFT "Create New Payment" page (Reference Details, Transaction Details, Payee Details) and "Confirm Payment" page (**not shown** in this guide) |
| | **Confirmation Page – NOT SHOWN**<br><br>Will have payment details again.<br>Transaction Number >> goes back into Tramada Reference field.<br><br>Alternatively, Transaction Number can be found from the Transactions page (see below). | | | | |
| | *No Sandbox, but has API access — see bottom of this document* | | | | Screenshot: MintEFT "Search Transactions" page, with filters (Date Range, Amount, Transaction ID, Status, References, Passenger Name, Payee, Created By, Bank's Reference, Authorized/Settled Date) and a results table (Transaction ID, Payment Date, From, To, Passenger, Amount, Currency, Recipient's Reference) |
| 8 | Travel consultant logins to **MintEFT**.<br><br>Click on "New Payment" on the left side navigation | MintEFT | Lands on Create New Payment page | | *Video 2:06 onwards* |
| 9 | Fill out the form from booking information from Tramada:<br><br>- **"Recipient Reference"** is the "Reference number" from Tramada<br>- **"Sender Reference"** is the "Booking Number" from Tramada<br>- **"Passenger Name"** is "Client last name" from Tramada *(unsure if AI can do this? PII)*<br>- **"Total Amount"** is "Creditor Payable" from Tramada (should already be nett amount in Tramada)<br>- **"Payment Date"** is Today's date<br>- **"Payee Name or Number"** is name of supplier from Tramada "Payment To" field – select from dropdown menu | MintEFT, Tramada | | If no reference number, AI agent raises to human and continues to populate the remainder fields. | |
| 10 | Click "Proceed with Payment" button.<br><br>*(AI agent stops here, notify human to check and proceed)* | MintEFT | Lands on Confirm Payment page | (AI agent stops here, notify human to check and proceed) | |
| 11 | Human checks, edits if needed, and clicks "Confirm" button.<br><br>A transaction ID number appears under Payment Details — format `M00XXXXXX` — this is the Mint transaction/payment reference (not to be confused with Payee Customer Numbers, which also start with "M" but format is `MXXXXXX`).<br><br>After human has made payment, continue to next step. | MintEFT | | Mint transaction numbers always start with M00... followed by another 6 numbers. 00 = the number zero. | |
| | *Back to Tramada* | | | | |
| 12 | In Tramada, on the Issue Creditor Payment page, copy the "Transaction ID" from Mint and paste it in "Reference" field. | Tramada, MintEFT | | Reference field must be filled in for reconciliation and auditing purposes. Mint transaction numbers always start with M00... followed by another 6 numbers. 00 = the number zero. | |
| 13 | Payment Details section:<br><br>- Add "Payee Name" as per "Client Name"<br>- Select "Date of Payment" to be Today's date<br>- "Amount of Payment" is the amount from "Creditor Payable" column in Segments to Allocate section below | | | | Screenshot: Tramada Payment Details form — Payee Name: MEGAN GRAY, Date Of Payment: 23-07-2026, Amount Of Payment: 374.29, Reference: M00655455 |
| 14 | Scroll down to Segments to Allocate and tick the checkbox in the A column to allocate | Tramada | | | Screenshot: Tramada "Segments to Allocate" table showing Reference, Creditor Sell, Creditor Cost, Creditor Payable, and Amounts columns; Payment Amt 374.29, Seg Total 374.29, BO Amt 0.00, Unallloc 0.00 |
| 15 | Click "Issue" button | Tramada | | | |
| 16 | AI Agent stops here, notifies human.<br><br>Travel consultant clicks "Account" under Booking Transactions on the left menu.<br><br>Verifies supplier/creditor has been paid. | Tramada | | | |
| | Top dropdown menu to have "Debtor Invoice" selected and click "Invoice" button | Tramada | Lands on Issue Debtor Invoice page | **Travel consultant does the invoicing step** | |
| | Scroll down to "Segments to Invoice", and tick the checkbox under the A column for the supplier/creditor that has just been paid. Click "Issue" button. | Tramada | Travel consultant then receives their commission | **Travel consultant does the invoicing step** | |

## Business Rules & Exceptions

- **BR01** — If no reference number found, AI agent raises to human and continues to populate the remainder fields.
- **BR02** — AI Agent must **never** process any type of payment on Mint or TravelPay. A human must be notified and process the payment.
- **BR03** — Mint transaction numbers always start with `M00...` followed by another 6 numbers. `00` = the number zero.

## Other Features

- Ability to start the AI Agent in Tramada once travel consultant is ready to make payment to supplier/creditor via MINT.
- Ability to start the AI Agent in Tramada once travel consultant has made payment, and AI Agent to receipt it in Tramada.
- Ability to log and show the steps AI Agent has taken to prepare payment to supplier for auditing purposes.
- Ability to log and show the steps AI Agent has taken to receipt the payment for auditing purposes.

## Other Notes

- Possible use of AI chat interface for this POC.
- Mint EFT has no spending cap or role-based restriction — any amount can be sent to any supplier from the Mint make payment screen, so a human must review and approve the payment before confirming. This was flagged as a required "human-in-the-loop" step for any future automation.
- Mint has API integration; details below.

### MintEFT API

MintEFT has an API, documented here: https://mint-payments.readme.io/reference/createtransaction

That link opens the "Create a new transaction" endpoint. From there, the full MintEFT specification sits in the left-hand navigation — scroll down to the "MintEFT API Specification" heading and expand the groups beneath it to see the available endpoints. Each endpoint page includes the request and response schemas along with sample code in Shell, Node, Ruby, PHP and Python. Note the base URL shown in the docs points to the UAT sandbox environment.

Please feel free to forward this on to the team at Scyne so they can review the specification against their requirements and confirm whether it fits what they're planning to build. If they have questions on the guide, send them through first; where questions are more technical, a session can be arranged with the development team to work through them directly.

---

**Angel Torres**, Senior Technical Support Specialist
1300 646 833 | +61 (2) 8752 7888
angel.torres@mintpayments.com
mintpayments.com
