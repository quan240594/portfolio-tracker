/** "How is this calculated?" for every figure built on the forward 12-month income (Dividends page, Dashboard, Calendar). */
export function ForwardIncomeInfo() {
  return (
    <>
      <p>
        <strong>How is this calculated?</strong> Forward income = declared dividends (announced, with an ex-date in the next 12 months) + an estimate for the regular payments of those 12 months that are not announced yet.
      </p>
      <p>
        The estimate uses how often the company pays and its latest regular dividend per share, from the data provider&apos;s dividend history (your own payments only when the provider has none), times the shares you hold now. Special dividends are left out. A holding with only one known payment is
        assumed to pay once a year and is flagged, because that is probably too low.
      </p>
      <p>
        Amounts are net of the withholding tax observed on your dividends of the last 12 months, in your base currency. The yield divides the forward income by the current market value (on cost: by what you paid). Broker apps quote the gross yield on the share price, before withholding tax, so
        their figure is higher; the Yield / payout table shows both.
      </p>
    </>
  );
}
