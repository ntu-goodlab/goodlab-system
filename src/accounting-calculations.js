export const ACCOUNTING_SOURCE_BANK = 'Bank';
export const ACCOUNTING_SOURCE_CASH = 'Cash';

export function normalizeAccountingSource(value) {
    return value === ACCOUNTING_SOURCE_CASH
        ? ACCOUNTING_SOURCE_CASH
        : ACCOUNTING_SOURCE_BANK;
}

export function getPaybackMethod(accountingItem) {
    if (!accountingItem) return ACCOUNTING_SOURCE_BANK;
    return normalizeAccountingSource(
        accountingItem.Payback_Method || accountingItem.Fund_Source
    );
}

export function calculateAccountingSummary(accountingItems = []) {
    let bankBalance = 0;
    let cashBalance = 0;
    let payable = 0;
    let receivable = 0;

    accountingItems.forEach(item => {
        const amount = Math.abs(Number(item.Amount) || 0);
        const type = item.Type;
        const isFund = item.Payer === 'Fund';
        const isRecharged = Boolean(item.Recharge_Date);
        const isPaidBack = Boolean(item.Payback_Date);
        const fundSource = normalizeAccountingSource(item.Fund_Source);
        const paybackMethod = getPaybackMethod(item);

        if (!isFund && !isPaidBack && (type === 'School' || type === 'Lab')) {
            payable += amount;
        }
        if (type === 'School' && !isRecharged) receivable += amount;

        if (type === 'Income' || type === 'Deposit') {
            if (fundSource === ACCOUNTING_SOURCE_CASH) cashBalance += amount;
            else bankBalance += amount;
        } else if (type === 'Withdraw' || type === 'Withdrawal') {
            bankBalance -= amount;
            cashBalance += amount;
        } else if (type === 'School' || type === 'Lab') {
            if (isFund) {
                if (fundSource === ACCOUNTING_SOURCE_CASH) cashBalance -= amount;
                else bankBalance -= amount;
            } else if (isPaidBack) {
                if (paybackMethod === ACCOUNTING_SOURCE_CASH) cashBalance -= amount;
                else bankBalance -= amount;
            }

            if (type === 'School' && isRecharged) bankBalance += amount;
        }
    });

    return {
        bankBalance,
        cashBalance,
        totalBalance: bankBalance + cashBalance,
        payable,
        receivable
    };
}
