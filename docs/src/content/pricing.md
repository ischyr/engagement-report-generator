# Pricing and invoicing

Out of the box, nothing in Engy Report has a price. Fill in the rate card and proposals gain one.

## The rate card

**Settings → The rate card.**

| Setting | What it does |
| --- | --- |
| **Standard day rate** | The default. Empty means proposals carry no price at all |
| **Currency** | A label, not a conversion — there is one currency here |
| **Floor day rate** | Below this, *after discount*, a price needs a manager's sign-off |
| **Discount a salesperson may give** | Above this, the same sign-off. Zero means every discount is a decision |
| **Tax label and rate** | Printed on the offer as you write it |
| **Days to pay** | Unless the client has their own terms |

A client can have its own day rate and its own payment terms, on the client record. A rate
negotiated two years ago should not be retyped onto every proposal.

## How a price is worked out

Three fallbacks, in order:

1. what this proposal quotes,
2. what this client pays,
3. what the rate card says.

Then: `rate × days`, less the discount, plus tax. The **days** are the ones the delivery side
agreed.

> [!note]
> A proposal never stores a total. Storing one as well as the rate would be two numbers that can
> disagree — which is the bug where the record says 40,000 and the contract says 45,000. Change the
> agreed effort and the price moves, because it always did; it just used to move in somebody's
> spreadsheet.

## The approval gate

A rate under the floor after discount, or a discount over the cap, blocks the offer from going out
until a manager signs it off — the same authority that signs the paperwork.

The approval is recorded against **the figures it was given for**. Get 30% signed off, then type
45%, and the signature lapses rather than quietly carrying over. Sales cannot approve its own
price, and a price back inside the rules needs no approval at all.

## On the offer

The price prints from your template. Every amount comes in two forms — a number, and the same thing
already written out with the currency:

```text
{{ price.netText }}          11 400.00 EUR
{{ price.dayRateText }}      1 200.00 EUR
{{ price.discountPercent }}  5
{{ price.taxLabel }} at {{ price.taxPercent }}%
{{ price.totalText }}

{{#isPriced}}…{{/isPriced}}      only when there is a real figure
{{#isDiscounted}}…{{/isDiscounted}}
```

`isPriced` is the guard worth using: a firm with no rate card should print an offer with no price
section, not one that says `0.00`, which reads as free work.

## Purchase orders

The commonest reason an invoice comes back is a missing purchase order number — and whether a
client needs one is knowable months in advance. Tick **They will not pay an invoice without a
purchase order** on the client, and every proposal for them is flagged until one is recorded.

The PO is the one field editable **after** acceptance, when everything else is frozen: the number
nearly always arrives afterwards, from somebody in the client's finance team who was on none of the
calls.

## The invoicing list

**Sales → Invoicing** is the handoff to whoever raises the invoices: won work, what it was worth,
whether a report has actually gone out, and what is blocking the invoice.

"Delivered" is read from the delivery record rather than the engagement's status, because that is
the moment most firms are willing to bill — a job can be marked finished internally while the
client still has nothing in their hands.

Mark one invoiced with its reference, and it leaves the outstanding list. **CSV** exports whatever
is on screen.

> [!note]
> Deliberately a CSV rather than an integration. This app cannot know which accounts package you
> use, and a column of numbers somebody can paste beats a connector nobody can configure.
