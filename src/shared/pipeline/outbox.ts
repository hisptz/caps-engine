import type { Prisma, PrismaClient } from "@db/client";

export type OutboxTx = Prisma.TransactionClient | PrismaClient;

export type EnqueueOutboxArgs = {
  destination: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
};

/** Persist a broker write that must be published after the surrounding transaction commits. */
export async function enqueueOutboxMessage(
  tx: OutboxTx,
  args: EnqueueOutboxArgs
): Promise<{ id: string }> {
  return tx.outboxMessage.create({
    data: {
      destination: args.destination,
      payload: args.payload as Prisma.InputJsonValue,
      availableAt: args.availableAt ?? new Date(),
    },
    select: { id: true },
  });
}
