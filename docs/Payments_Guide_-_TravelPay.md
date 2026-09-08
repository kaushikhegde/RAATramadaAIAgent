# Payments: TravelPay (Supplier)

| Step | Actions | System | Expected Result | Decision / Rule | Evidence screenshot |
|---|---|---|---|---|---|
| 1 | Travel consultant searches via Booking number in Tramada and click to view the Booking (e.g. 13061) | Tramada | Lands on Booking Summary page | | |
| 2 | Click "Payments" under Booking Transaction on the left nav panel | Tramada | Lands on Booking Payments page | | |
| 3 | Dropdown at top right should be "Creditor Payment", click "Add/Issue Payment" button | Tramada | Lands on Issue Creditor Payment page | | |
| 4 | Transaction Type field, select "EFT" from dropdown | Tramada | | | |
| 5 | Payment To field, select Supplier name from dropdown | Tramada | | | |
| 6 | Use the information under Segments to Allocate to pay the supplier. Reference number is found in the text under the column "Reference". Amount to pay is found under the "Creditor Payable" column | Tramada | | | |
| — | **TravelPay interface** | | | | |
| 7 | Travel consultant logins to TravelPay. Click on "Make A Payment" on the left side navigation | TravelPay | Lands on https://b2b.travelpay.com.au | | |
| 8 | Fill out the form from booking information from Tramada. | TravelPay, Tramada | | If no reference number, AI agent raises to human and continues to populate the remainder fields.<br><br>"Supplier" is the "Payment To" selected supplier name from Tramada.<br>"Pay" field is "Pay Now".<br>"Supplier Booking Reference" is the alphanumeric characters found in the "Reference" column from Tramada Segment To Allocate section.<br>"Passenger Name" is "Client last name" and booking number from Tramada (unsure if AI can do this? PII).<br>"Payment Amount" is "Creditor Payable" from Tramada (should already be nett amount in Tramada).<br>"Payment Account" can be left as is (Existing Account – Bank...).<br><br>"Supplier Booking Reference" can also be found in the Tramada Booking, click into "Costing", click into the supplier segment, under Status Details, "Creditor Inv. No." which the alphanumeric reference can be found.<br>"Passenger Name" will be LAST NAME + TRAMADA BOOKING NO – e.g. "GRAY 123456" | |
| 9 | (AI agent stops here, notify human to check and proceed). Human comes onto this page and ticks the confirmation checkbox and clicks "Pay Now". After human has made payment, continue to next step | TravelPay | (AI agent stops here, notify human to check and proceed) | | |
| 10 | A transaction ID number appears — an 8-digit number that needs to be captured. This can also be found through "My Payment History" from the left nav panel | TravelPay | | | |
| — | **Back to Tramada** | | | | |
| 11 | In Tramada, on the Issue Creditor Payment page, copy the "Transaction ID" from TravelPay and paste it in "Reference" field | Tramada, TravelPay | | Reference field must be filled in for reconciliation and auditing purposes. | |
| 12 | Payment Details section, add "Payee Name" as per "Client Name". Select "Date of Payment" to be Today's date. "Amount of Payment" is the amount from "Creditor Payable" column in Segments to Allocate section below | | | | |
| 13 | Scroll down to Segments to allocate and tick the checkbox in A column to allocate | Tramada | | | |
| 14 | Click "Issue" button | Tramada | | | |
| 15 | AI Agent stops here, notifies human. Travel consultant clicks to "Account" under Booking Transactions on the left menu. Verifies supplier/creditor has been paid. | Tramada | | | |

## Business Rules & Exceptions

| # | Rule |
|---|---|
| BR01 | If no reference number found, AI agent raises to human and continues to populate the remainder fields. |
| BR02 | AI Agent must never process any type of payment on Mint or TravelPay. A human must be notified and process the payment. |
| BR03 | Passenger Name for TravelPay must be PASSENGER LAST NAME + TRAMADA BOOKING NO – e.g. "GRAY 123456". |
| BR04 | A transaction ID of an 8-digit number from TravelPay must be entered to Tramada's Reference field. |

## Other features

- Ability to start the AI Agent in Tramada once travel consultant is ready to make payment to supplier/creditor via TravelPay.
- Ability to start the AI Agent in Tramada once travel consultant has made payment, and AI Agent to receipt it in Tramada.
- Ability to log and show the steps AI Agent has taken to prepare payment to supplier for auditing purposes.
- Ability to log and show the steps AI Agent has taken to receipt the payment for auditing purposes.

## Other notes

- Possible use of AI chat interface for this POC.
- TravelPay may have API integration but requires further investigation: https://api.travelpay.com.au/swagger/ui/index
