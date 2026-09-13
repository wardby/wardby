-- Additive: distinguish webhook-triggered runs from manual/scheduled ones.
ALTER TYPE "RunTrigger" ADD VALUE 'webhook';
