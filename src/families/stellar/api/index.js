//@flow

import { BigNumber } from "bignumber.js";
import StellarSdk from "stellar-sdk";
import { getCryptoCurrencyById, parseCurrencyUnit } from "../../../currencies";
import { encodeOperationId } from "../../../operation";

const LIMIT = 200;
const FALLBACK_BASE_FEE = 100;

const server = new StellarSdk.Server("https://horizon.stellar.org");
const currency = getCryptoCurrencyById("stellar");

const fetchBaseFee = async () => {
  let baseFee;

  try {
    baseFee = await server.fetchBaseFee();
  } catch (e) {
    baseFee = FALLBACK_BASE_FEE;
  }

  return baseFee;
};

const getMinimumBalance = (account) => {
  const baseReserve = 0.5;
  const numberOfEntries = account.subentry_count;

  const minimumBalance = (2 + numberOfEntries) * baseReserve;

  return parseCurrencyUnit(currency.units[0], minimumBalance.toString());
};

const getAccountSpendableBalance = async (balance, account) => {
  const minimumBalance = getMinimumBalance(account);
  const baseFee = await fetchBaseFee();
  const res = BigNumber.max(balance.minus(minimumBalance).minus(baseFee), 0);

  return res;
};

/**
 * Get all account-related data
 *
 * @async
 * @param {*} addr
 */
export const getAccount = async (addr: string) => {
  let account = {};
  let balance = {};
  try {
    account = await server.accounts().accountId(addr).call();
    balance = account.balances.find((balance) => {
      return balance.asset_type === "native";
    });
  } catch (e) {
    if (e.name === "NotFoundError") {
      balance.balance = "0";
    } else {
      throw e;
    }
  }

  const formattedBalance = parseCurrencyUnit(
    currency.units[0],
    balance.balance
  );
  const spendableBalance = await getAccountSpendableBalance(
    formattedBalance,
    account
  );

  return {
    blockHeight: account.sequence ? Number(account.sequence) : null,
    balance: formattedBalance,
    spendableBalance,
  };
};

const getOperationType = (operation, addr) => {
  switch (operation.type) {
    case "create_account":
      return operation.funder === addr ? "OUT" : "IN";
    case "payment":
      if (operation.from === addr && operation.to !== addr) {
        return "OUT";
      }
      return "IN";

    default:
      return "NONE";
  }
};

const getRecipients = (operation) => {
  switch (operation.type) {
    case "create_account":
      return [operation.account];
    case "payment":
      return [operation.to];

    default:
      return [];
  }
};

/**
 * Fetch all operations for a single account from indexer
 *
 * @param {string} accountId
 * @param {string} addr
 * @param {number} startAt - blockHeight after which you fetch this op (included)
 *
 * @return {Operation[]}
 */
export const getOperations = async (
  accountId: string,
  addr: string,
  startAt: number = 0
) => {
  const transactions = await fetchTransactionsList(accountId, addr, startAt);
  return await fetchOperationList(accountId, addr, transactions);
};

const fetchTransactionsList = async (
  accountId: string,
  addr: string,
  startAt: number
) => {
  let transactions = {};
  let mergedTransactions = [];

  try {
    transactions = await server
      .transactions()
      .forAccount(addr)
      .cursor(startAt)
      .limit(LIMIT)
      .call();

    mergedTransactions = transactions.records;

    while (transactions.records.length > 0) {
      transactions = await transactions.next();
      mergedTransactions = mergedTransactions.concat(transactions.records);
    }
  } catch (e) {
    if (e.name !== "NotFoundError") {
      throw e;
    }

    return [];
  }

  return mergedTransactions;
};

const fetchOperationList = async (accountId, addr, transactions) => {
  let formattedMergedOp = [];

  for (let i = 0; i < transactions.length; i++) {
    let operations = await server
      .operations()
      .forTransaction(transactions[i].id)
      .call();

    formattedMergedOp = formattedMergedOp.concat(
      operations.records.map((operation) => {
        return formatOperation(operation, transactions[i], accountId, addr);
      })
    );

    while (operations.records.length > 0) {
      operations = await operations.next();

      formattedMergedOp = formattedMergedOp.concat(
        operations.records.map((operation) => {
          return formatOperation(operation, transactions[i], accountId, addr);
        })
      );
    }
  }

  return formattedMergedOp;
};

const formatOperation = (rawOperation, transaction, accountId, addr) => {
  const value = getValue(rawOperation);
  const type = getOperationType(rawOperation, addr);
  const recipients = getRecipients(rawOperation);

  return {
    id: encodeOperationId(accountId, rawOperation.transaction_hash, type),
    accountId,
    fee: parseCurrencyUnit(currency.units[0], transaction.fee_charged),
    value,
    type: type,
    hash: rawOperation.transaction_hash,
    blockHeight: transaction.ledger_attr,
    date: new Date(rawOperation.created_at),
    senders: [rawOperation.source_account],
    recipients,
    transactionSequenceNumber: transaction.source_account_sequence,
    hasFailed: !rawOperation.transaction_successful,
  };
};

const getValue = (operation) => {
  if (operation.type === "create_account") {
    return parseCurrencyUnit(currency.units[0], operation.starting_balance);
  }

  if (operation.type === "payment" && operation.asset_type === "native") {
    return parseCurrencyUnit(currency.units[0], operation.amount);
  }

  return BigNumber(0);
};
