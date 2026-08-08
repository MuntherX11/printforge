import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { optionalNumber, requiredNumber, requiredText, requiredEnum } from '../common/utils/validate-number';

const ACCOUNT_TYPES = ['BANK', 'CASH', 'CARD', 'OTHER'] as const;
const MONEY = { min: -100_000_000, max: 100_000_000 };

/** OMR is 3dp — round every posted figure so balances can't drift on floats. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

@Injectable()
export class AccountsService {
  constructor(private prisma: PrismaService) {}

  // ------------------------------------------------------------------ accounts

  async create(dto: any) {
    const name = requiredText(dto?.name, 'Name', 120);
    const type = dto?.type ? requiredEnum(dto.type, 'type', ACCOUNT_TYPES) : 'BANK';
    const opening = optionalNumber(dto?.openingBalance, 'openingBalance', MONEY) ?? 0;

    return this.prisma.$transaction(async (tx) => {
      // Only one default account may exist.
      if (dto?.isDefault) {
        await tx.account.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      }
      const account = await tx.account.create({
        data: {
          name,
          type: type as any,
          reference: dto?.reference?.trim().slice(0, 120) || null,
          notes: dto?.notes?.trim().slice(0, 500) || null,
          balance: round3(opening),
          // First account created becomes the default, so invoice payments
          // always have somewhere to land.
          isDefault: dto?.isDefault ?? (await tx.account.count()) === 0,
        },
      });
      if (opening !== 0) {
        await tx.accountTransaction.create({
          data: {
            accountId: account.id,
            amount: round3(opening),
            balanceAfter: round3(opening),
            type: 'OPENING_BALANCE',
            description: 'Opening balance',
          },
        });
      }
      return account;
    });
  }

  findAll() {
    return this.prisma.account.findMany({
      orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { transactions: true } } },
    });
  }

  async findOne(id: string, limit = 100) {
    const account = await this.prisma.account.findUnique({
      where: { id },
      include: {
        transactions: {
          orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
          take: Math.min(Math.max(limit, 1), 500),
        },
      },
    });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  async update(id: string, dto: any) {
    await this.ensure(id);
    return this.prisma.$transaction(async (tx) => {
      if (dto?.isDefault) {
        await tx.account.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      }
      return tx.account.update({
        where: { id },
        data: {
          name: dto?.name !== undefined ? requiredText(dto.name, 'Name', 120) : undefined,
          type: dto?.type !== undefined ? (requiredEnum(dto.type, 'type', ACCOUNT_TYPES) as any) : undefined,
          reference: dto?.reference !== undefined ? dto.reference?.trim().slice(0, 120) || null : undefined,
          notes: dto?.notes !== undefined ? dto.notes?.trim().slice(0, 500) || null : undefined,
          isDefault: dto?.isDefault,
          isActive: dto?.isActive,
        },
      });
    });
  }

  async remove(id: string) {
    const account = await this.ensure(id);
    const movements = await this.prisma.accountTransaction.count({ where: { accountId: id } });
    if (movements > 0) {
      throw new BadRequestException(
        `This account has ${movements} transaction${movements === 1 ? '' : 's'} and is kept for your records. ` +
        `Mark it inactive instead.`,
      );
    }
    if (account.isDefault) {
      throw new BadRequestException('This is the default account — make another account the default first.');
    }
    await this.prisma.account.delete({ where: { id } });
    return { deleted: true };
  }

  // -------------------------------------------------------------- transactions

  /**
   * The single place money moves. Writes the transaction and steps the running
   * balance in one transaction so the two can never disagree.
   */
  async post(params: {
    accountId: string;
    amount: number;           // + credits, - debits
    type: string;
    description: string;
    reference?: string | null;
    invoiceId?: string | null;
    expenseId?: string | null;
    occurredAt?: Date;
    tx?: any;                 // join an outer transaction when there is one
  }) {
    const run = async (db: any) => {
      const account = await db.account.findUnique({ where: { id: params.accountId } });
      if (!account) throw new NotFoundException('Account not found');

      const amount = round3(params.amount);
      const balanceAfter = round3(account.balance + amount);

      const entry = await db.accountTransaction.create({
        data: {
          accountId: account.id,
          amount,
          balanceAfter,
          type: params.type as any,
          description: params.description.slice(0, 300),
          reference: params.reference?.slice(0, 120) ?? null,
          invoiceId: params.invoiceId ?? null,
          expenseId: params.expenseId ?? null,
          occurredAt: params.occurredAt ?? new Date(),
        },
      });
      await db.account.update({ where: { id: account.id }, data: { balance: balanceAfter } });
      return entry;
    };
    return params.tx ? run(params.tx) : this.prisma.$transaction(run);
  }

  /** Manual correction — a cash count, a bank fee, anything unmodelled. */
  async adjust(id: string, dto: { amount: number; description?: string }) {
    await this.ensure(id);
    const amount = requiredNumber(dto?.amount, 'amount', MONEY);
    if (amount === 0) throw new BadRequestException('Adjustment cannot be zero');
    return this.post({
      accountId: id,
      amount,
      type: 'ADJUSTMENT',
      description: dto?.description?.trim().slice(0, 300) || 'Manual adjustment',
    });
  }

  /** Move money between two accounts as a matched pair of entries. */
  async transfer(dto: { fromAccountId: string; toAccountId: string; amount: number; description?: string }) {
    const amount = requiredNumber(dto?.amount, 'amount', { min: 0.001, max: MONEY.max });
    if (dto.fromAccountId === dto.toAccountId) {
      throw new BadRequestException('Choose two different accounts');
    }
    const [from, to] = await Promise.all([this.ensure(dto.fromAccountId), this.ensure(dto.toAccountId)]);
    if (from.balance < amount) {
      throw new BadRequestException(`${from.name} only has ${from.balance.toFixed(3)} available`);
    }
    const note = dto?.description?.trim().slice(0, 200);
    return this.prisma.$transaction(async (tx) => {
      await this.post({
        accountId: from.id, amount: -amount, type: 'TRANSFER_OUT', tx,
        description: note || `Transfer to ${to.name}`,
      });
      await this.post({
        accountId: to.id, amount, type: 'TRANSFER_IN', tx,
        description: note || `Transfer from ${from.name}`,
      });
      return { moved: round3(amount), from: from.name, to: to.name };
    });
  }

  /** The account invoice payments land in. */
  async defaultAccount(tx?: any) {
    const db = tx ?? this.prisma;
    return (await db.account.findFirst({ where: { isDefault: true, isActive: true } }))
      ?? (await db.account.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } }));
  }

  /** Totals for the accounting overview. */
  async summary() {
    const accounts = await this.prisma.account.findMany({ where: { isActive: true } });
    return {
      totalBalance: round3(accounts.reduce((s, a) => s + a.balance, 0)),
      accounts: accounts.length,
      byType: ACCOUNT_TYPES.map((t) => ({
        type: t,
        balance: round3(accounts.filter((a) => a.type === t).reduce((s, a) => s + a.balance, 0)),
      })).filter((r) => r.balance !== 0),
    };
  }

  private async ensure(id: string) {
    const a = await this.prisma.account.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Account not found');
    return a;
  }
}
