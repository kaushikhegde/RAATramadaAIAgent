# Payments: DVC (Supplier)

*Reference Discovery Workshop 1 for DVC at 2:21:50*

| Step | Actions | System | Expected Result | Decision / Rule | Evidence screenshot |
|---|---|---|---|---|---|
| 1 | Travel consultant searches via Booking number in Tramada and click to view the Booking (e.g. 13061) | Tramada | Lands on Booking Summary page | | |
| 2 | Click "Receipts" under Booking Transaction on the left nav panel | Tramada | Lands on Booking Receipts page | | |
| 3 | Dropdown at top right should be "Agency CC Debtor Receipt", click "Add/Issue Receipt" button | Tramada | Lands on Issue Agency Credit Card Transaction page | | |
| 4 | Creditor field, select Supplier name from dropdown | Tramada | | Travel consultant selects the Supplier they want to pay | |
| 5 | Travel Consultant logs into the Westpac commercial account and completes two-factor authentication (2FA), and confirms once logged in | Westpac Commercial Cards portal | Logged in to Westpac. | A human must complete login and 2FA unless Westpac's API is used instead | |
| 6 | In Westpac portal, navigate to Payment Control > Purchase Requests > Create Single Request | Westpac Commercial Cards portal, AI Agent | Lands on Create Single Request page. | | |
| 7 | In the purchase Template field, select "RAA – DVC Supplier Payments Template" | Westpac Commercial Cards portal | | | |
| 8 | Travel Consultant indicates validity period based on type of payment by entering Start Date field — leave defaulted to today's date, or change to custom start date. Enter End Date field — set to either 7 days from start date if 'standard', or enter custom check in date | Westpac Commercial Cards portal | | - Start date options to be: From today. <br> - Validity periods options to be: 7 days – standard; Custom – for overseas hotel bookings with check in date beyond 7 days. <br> - If Consultant selects 'custom' prompt them to enter the date of check in, and set 'end date' to this date. <br> - End date must be within 2 years of start date. If check-in date provided is over 2 years from today's date, flag that start date must be set to a date within 2 years of the check in date | |
| 9 | In the Cumulative Limit field — enter the amount owed plus a $5 buffer | Westpac Commercial Cards portal | | - Buffer should be within $5 to cover potential credit card fees. <br> - If the cumulative limit exceeds $20,000, the card requires approval from another authorised person before it becomes valid to use. | |
| 10 | In the Maximum Number of Transactions field — leave at 0 | Westpac Commercial Cards portal | | | |
| 11 | Under the Supplier Details section, Supplier field, select the Travel Consultant's branch/store name from Booking Profile page in Tramada, "Level 1 Branch" field. Supplier Emails field should be prepopulated based on the branch selection above. User Defined Emails to input travel consultant email address | | | - AI interface must include ability to upload an excel file under a Travel Consultant cheat sheet. <br> - Travel Consultant Details to confirm: Branch, Branch email address, Their RAA email address | |
| 12 | Under Custom Data Fields — populate from Tramada booking details:<br>- Agent Initials, input take the first letter of travel consultant's first name and the first letter of their last name, from top left of booking page.<br>- Store Code (e.g. MIL, WLK, MAR), input from Booking Profile page in Tramada, "Level 1 Branch" field.<br>- Supplier Name (who is being paid, e.g. Room-Res), input from Issue Agency Credit Card Transaction page, Creditor field.<br>- Supplier Reference, input from Issue Agency Credit Card Transaction page, Segments to Allocate section, Reference column.<br>- Tramada Booking Number, input from top left of Tramada booking page.<br>- Member/Pax Name (lead passenger name), input from top left of Tramada booking page, Client Name.<br>- Segment Type (e.g. Hotel, Air Ticket), input from Issue Agency Credit Card Transaction page, Segments to Allocate section, Seg. Type column.<br>- Card Request Date (today's date) in the format DD.MM.YYYY | Westpac Commercial Cards portal, Tramada | All custom data fields populated. | - If any of these fields are missing from the Tramada booking, flag with Travel Consultant which details are missing, and prompt them to either edit Tramada booking or supply missing details via AI interface. <br> - Only enter Supplier Reference if already captured in Tramada. <br> - For Tramada booking number, enter numbers only – letters will not be accepted. <br> - Card request date must be in the format DD.MM.YYYY | |
| 13 | Travel Consultant checks all details in Westpac portal are correct, makes any edits, and clicks "Submit" | Westpac Commercial Cards portal | DVC/VCC is generated, with full card number, expiry date and CVV displayed once for immediate use. | - One DVC must be generated per supplier, per booking/transaction — if Consultant wants to pay multiple suppliers, DVC creation process must be repeated for each supplier. <br> - 'Submit' must be completed by a human, AI agent must not select 'Submit' | |
| 14 | On the Purchase Request details page, copy the card details shown and enter them into the Tramada booking's Summary page, Booking notes section | Westpac Commercial Cards portal, Tramada | Card details recorded against the booking for reference before use. | - Card details to enter into Tramada booking notes: Virtual credit card number, Expiry date, CVC | |
| 15 | Travel consultant pays Supplier with DVC details on supplier's portal (e.g. Room-Res, Jetstar, overseas hotel). Confirms payment has been made. Captures payment reference number | Travel consultant, Supplier portal | | | |
| 16 | In Tramada, navigate back to Issue Agency Credit Card Transaction page. Under Credit Card Details, Credit Card field, select "Westpac DVC" from dropdown (should only have one option). Authorisation Number field, input "XX6780". Under Receipt Details section, Payer Name to input travel consultant name from "Cons1" field. Amount Received, input amount from "Creditor Due" column in Segments to allocation section. Reference field, input reference from Reference column in Segments to allocation section with a "RRC - " prefix. Example RRC – MG752045, where MG752045 is the reference number. | Tramada | | Reference field in Tramada must have a "RRC - " prefix. Example reference "RRC – MG752045", where MG752045 is the reference number. | |
| 17 | Scroll down to Segments to allocate and tick the checkbox in A column to allocate | Tramada | | | |
| 18 | Click "Issue" button | Tramada | | | |

## Business Rules & Exceptions

| # | Rule |
|---|---|
| BR01 | A human must complete Westpac login and 2FA. This cannot be automated unless Westpac's API is used instead of the browser UI. |
| BR02 | The amount owed found in the supplier portal must be cross-checked against the amount owed in Tramada. If they don't match, the Travel Consultant must be prompted to manually confirm the correct supplier booking number, and the discrepancy flagged so the Travel Consultant can specify the correct amount to pay. |
| BR03 | Standard validity period is 7 days from the start date. A custom period must be used for overseas hotel bookings where check-in is beyond 7 days, using the check-in date as the End Date. End Date must fall within 2 years of the Start Date — if a provided check-in date is more than 2 years away, the Start Date must be adjusted so the End Date still falls within 2 years of it, and this must be flagged. |
| BR04 | Cumulative Limit is the amount owed plus a $5 buffer (to cover potential credit card fees) and round up to the nearest dollar. E.g. If amount due is $246.75, then enter $252 in the field. If the resulting cumulative limit exceeds $20,000, the card requires approval from another authorised person before it becomes valid to use. |
| BR05 | Maximum Number of Transactions must always remain at 0 (unlimited), to allow for suppliers who post multiple separate charges per booking. |
| BR06 | Supplier Reference should only be entered if already captured in Tramada. Tramada Booking Number must be numbers only. Card Request Date must be in DD.MM.YYYY format. |
| BR07 | The final "Submit" button in Westpac must always be actioned by a human — the AI Agent must never select Submit itself, even after preparing and displaying a full summary for review. |
| BR08 | One DVC must be generated per supplier, per booking/transaction. Paying multiple suppliers requires repeating the entire DVC creation process for each one individually. |
| BR09 | Once generated, the card number, expiry date, and CVC must be copied from Westpac into the Tramada booking's Summary page notes before the card is used. |
| BR10 | A human must check the payment details and submit the payment in the supplier portal — the AI Agent must never submit this payment itself. |
| BR11 | The payment reference number generated by the supplier portal on payment confirmation must be entered into Tramada's Reference field with "RRC - " as a prefix — required for reconciliation and auditing. |
| BR12 | In Tramada's Payment Details section: Payee Name is entered as the "Client Name"; Date of Payment is set to today's date; Amount of Payment is sourced from the "Creditor Payable" column in Segments to Allocate. |

## Other features

- Ability to present a full summary of all entered details (Travel Consultant details, validity period, cumulative limit, custom data fields) for review before requiring a human to physically click Submit in Westpac.
- Ability to detect and flag missing Tramada booking data required for Custom Data Fields, prompting the Travel Consultant to correct the source booking or supply it directly via the AI interface.
- Ability to store DVC card details securely for autofill via LastPass in supplier portals, rather than requiring manual entry or direct AI Agent handling of card numbers.
- Ability to pause the receipting process or start the process again after human has made actual payment to supplier, and then continue to receipt the supplier in Tramada.

## Other notes

- Westpac has an API for DVC which may enable direct automation, in which case a sandbox environment will be created.
- Supplier portals will differ in terms of layout to navigate to locate and pay for bookings – payment automation may need to be for select suppliers only or action may need to be completed by human.
