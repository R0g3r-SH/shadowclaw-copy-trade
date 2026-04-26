import { logger } from '../utils/logger';
import { config } from '../config';
import { TelegramBot } from '../services/telegram';
import { DatabaseService } from '../services/database';
import { AgentService } from '../agent/agent-service';
import { dash } from '../dashboard/events';
import type { SafetyResult } from '../safety/token-safety';

export interface DecisionContext {
  walletAddress: string;
  walletScore: number;
  tokenAddress: string;
  tokenIn: string;
  maxAmountUsd: number;
  safetyResult: SafetyResult;
  originalTxHash: string;
}

export interface Decision {
  shouldExecute: boolean;
  requiresApproval: boolean;
  reason: string;
  approved?: boolean;
  agentConfidence?: number;
  alreadyExecuted?: boolean;
  suggestedAmountUsd?: number;
}

export class HybridDecisionEngine {
  constructor(
    private telegram: TelegramBot,
    private db: DatabaseService,
    private agent: AgentService
  ) {}

  async makeDecision(context: DecisionContext): Promise<Decision> {
    const mode = config.trading.autonomyMode;
    logger.info(`Making decision in ${mode} mode`);
    return await this.agentDecide(context, mode);
  }

  private async agentDecide(context: DecisionContext, mode: 'claude-code' | 'hybrid' | 'openclaw'): Promise<Decision> {
    logger.info(`Agent deciding in ${mode} mode`);

    const agentDecision = await this.agent.analyzeAndDecide(
      {
        walletAddress: context.walletAddress,
        walletScore: context.walletScore,
        tokenAddress: context.tokenAddress,
        tokenIn: context.tokenIn,
        maxAmountUsd: context.maxAmountUsd,
        originalTxHash: context.originalTxHash,
      },
      mode
    );

    dash.emit('log', {
      severity: 'claude',
      message: `🤖 Agente: ${agentDecision.executedTrade ? 'EJECUTÓ' : agentDecision.requestsApproval ? 'PIDE APROBACIÓN' : 'SKIP'} · conf: ${agentDecision.confidence}% · $${agentDecision.suggestedAmountUsd?.toFixed(2) ?? '?'}`,
    });
    await this.db.logEvent('trade', 'info',
      `Agente decisión: ${agentDecision.executedTrade ? 'ejecutó' : agentDecision.requestsApproval ? 'pide aprobación' : 'skip'} · conf: ${agentDecision.confidence}% · ${agentDecision.reasoning.slice(0, 120)}`,
      { confidence: agentDecision.confidence, amount: agentDecision.suggestedAmountUsd }
    );

    // Agent auto-executed via tool
    if (agentDecision.executedTrade) {
      await this.telegram.sendAlert('info',
        `✅ *Trade auto-ejecutado*\n\nConfianza: ${agentDecision.confidence}%\n\n${agentDecision.reasoning}`
      );
      return {
        shouldExecute: false,
        alreadyExecuted: true,
        requiresApproval: false,
        reason: agentDecision.reasoning,
        agentConfidence: agentDecision.confidence,
        suggestedAmountUsd: agentDecision.suggestedAmountUsd,
      };
    }

    // Agent wants human approval
    if (agentDecision.requestsApproval) {
      const approved = await this.requestApprovalWithAnalysis(context, agentDecision);
      return {
        shouldExecute: approved,
        requiresApproval: true,
        approved,
        reason: approved ? 'Usuario aprobó' : 'Usuario rechazó',
        agentConfidence: agentDecision.confidence,
        suggestedAmountUsd: agentDecision.suggestedAmountUsd,
      };
    }

    // Agent skipped — orchestrator will emit the skip event
    return {
      shouldExecute: false,
      requiresApproval: false,
      reason: agentDecision.reasoning,
      agentConfidence: agentDecision.confidence,
    };
  }

  private async requestApprovalWithAnalysis(
    context: DecisionContext,
    agentDecision: { confidence: number; reasoning: string; suggestedAmountUsd: number }
  ): Promise<boolean> {
    try {
      const requestId = await this.db.createApprovalRequest({
        requestType: 'trade_execution',
        walletAddress: context.walletAddress,
        tokenAddress: context.tokenAddress,
        amountUsd: agentDecision.suggestedAmountUsd,
        riskScore: context.safetyResult.riskScore,
      });

      const wallet = context.walletAddress;
      const token = context.tokenAddress;
      const conf = agentDecision.confidence;
      const confEmoji = conf >= 80 ? '🟢' : conf >= 60 ? '🟡' : conf >= 40 ? '🟠' : '🔴';

      const message =
        `${confEmoji} *APROBACIÓN REQUERIDA*\n\n` +
        `*Wallet:* \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\` (score: ${context.walletScore})\n` +
        `*Token:* \`${token.slice(0, 6)}...${token.slice(-4)}\`\n` +
        `*Monto sugerido:* $${agentDecision.suggestedAmountUsd.toFixed(2)}\n` +
        `*Confianza agente:* ${conf}%\n\n` +
        `*Análisis:*\n${agentDecision.reasoning}\n\n` +
        `_Timeout: ${config.telegram.approvalTimeout / 1000}s_`;

      dash.emit('log', { severity: 'warning', message: `⏳ Esperando aprobación · $${agentDecision.suggestedAmountUsd.toFixed(2)} · conf: ${conf}%` });

      const approved = await this.telegram.requestApproval(message, config.telegram.approvalTimeout);

      await this.db.updateApprovalRequest(requestId, approved ? 'approved' : 'rejected');
      dash.emit('log', { severity: approved ? 'trade' : 'info', message: `${approved ? '✅ Aprobado' : '❌ Rechazado'} por usuario` });

      return approved;
    } catch (error) {
      logger.error({ error }, 'Error requesting approval');
      return false;
    }
  }
}
