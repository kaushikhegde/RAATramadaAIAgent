# Payments: IPSI (Customers)

*Process is from taking credit card payments from customers, over the phone or in store*

| Step | Actions | System | Expected Result | Decision / Rule | Evidence screenshot |
|---|---|---|---|---|---|
| 1 | Travel consultant answers the customer's phone call and prompts the customer to recite their booking number (or identifying details). Travel consultant gets credit card details from customer and input to IPSI for payment to be made. After payment is made, IPSI page will show "Approved". | Phone, IPSI | IPSI Tramada Secure Payment Page, Approved page will show information on:<br>- Booking number<br>- IPSI transaction reference number<br>- Cardholder name<br>- Amount | | |
| 2 | Search Tramada based on booking number. | Tramada | Land on Booking Summary page | | |
| 3 | Click on "Receipts" under Booking Transactions on left navigation | Tramada | Land on Issue Debtor Payment Receipt page. | | |
| 4 | Receipt Overview section, transaction type field, select "Credit Card Swipe" | Tramada | | Transaction Type must be set to "Credit Card Swipe". Bank Account must be set to "[TRUST] Trust Account". Received From must be set to "RAA of SA Limited (Retail)" | |
| 5 | Credit Card Details section, Credit card field, click "Add" button | Tramada | Add Credit Card module pop out | | |
| 6 | Category field, select "Personal". Card Number field, input RAA Dummy Card. Card Type field, to be same as what customer has given in Step 1. Card Holder field, override prepopulated value with "Cardholder name" from Step 1 IPSI approved page. Click "Done" button | Tramada, IPSI | RAA Dummy card details will be provided. | | |
| 7 | Receipt section, Payer Name field to be "Cardholder name" from Step 1 IPSI approved page. Amount Received field, input "Amount" from Step 1 IPSI approved page. Reference field, input "IPSI transaction reference number" from Step 1 IPSI approved page | Tramada, IPSI | Lands on Booking Summary page. | Transaction reference number must be entered into Tramada's Reference field | |
| 8 | Segments To Allocate section, tick the checkbox under column A for the same amount to allocate to | Tramada | Lands on Booking Account page. | Segments selected and amounts allocated must match before ticking the checkbox. | |
| 9 | Click "Issue". | Tramada | | | |

## Business Rules & Exceptions

| # | Rule |
|---|---|
| BR01 | Travel Consultant to confirm whether the person paying matches the customer on the booking, or capture the first and last name of the actual payer if different. |
| BR02 | Card type must be confirmed with the customer before dummy card details can be populated in Tramada. |
| BR03 | Transaction Type must be set to "Credit Card Swipe"; Bank Account must be set to "[TRUST] Trust Account"; Received From must be set to "RAA of SA Limited (Retail)". |
| BR04 | RAA is never permitted to hold or enter a customer's actual credit card number in Tramada. A dummy card matching the customer's confirmed card type must always be used instead. |
| BR05 | Cardholder Name field must be overwritten with the actual paying customer's name (as confirmed via the AI interface), not left as the dummy card's default name. |
| BR06 | Segments selected and amounts allocated must match before ticking the checkbox. |
| BR07 | AI Agent must never process or submit the actual credit card charge in IPSI. A human must complete this step, as it requires live, real-time interaction with the customer and their card details. |

## Other features

- Ability to log and show the steps the AI Agent has taken to prepare the receipt, for auditing purposes.
- Ability for the AI Agent to flag/stop when required information (e.g. reference number) is missing, rather than letting the process continue regardless.
- AI Agent needs to stop for human-in-the-loop check to confirm Tramada receipt details, add in customer name before receipting.

## Other notes

- Workflow currently excludes AI agent entering details directly into IPSI payment gateway.
- Bryan to investigate API options, if not browser automation.
- How to connect between the different systems?
- Cannot use first name so travel consultant will have to input that, and issue receipt at end of day.
