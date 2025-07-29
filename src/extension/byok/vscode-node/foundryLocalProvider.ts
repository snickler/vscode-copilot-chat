/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';
import { BaseOpenAICompatibleLMProvider } from './baseOpenAICompatibleProvider';
import { IBYOKStorageService } from './byokStorageService';

// Import Foundry Local SDK
import { FoundryLocalManager } from 'foundry-local-sdk';

// Minimum supported Foundry Local version - versions below this may have compatibility issues
const MINIMUM_FOUNDRY_VERSION = '1.0.0';

export class FoundryLocalLMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'FoundryLocal';
	private _modelCache = new Map<string, IChatModelInformation>();
	private _foundryManager: FoundryLocalManager | undefined;

	constructor(
		foundryServiceUrl: string | undefined,
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		// Create Foundry manager - if serviceUrl is provided, use the browser version
		// Otherwise use the Node.js version which auto-discovers the service
		const foundryManager = foundryServiceUrl
			? new (FoundryLocalManager as any)({ serviceUrl: foundryServiceUrl })  // Browser version
			: new FoundryLocalManager();  // Node.js version with auto-discovery

		super(
			BYOKAuthType.None,
			FoundryLocalLMProvider.providerName,
			foundryManager.endpoint,
			undefined,
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService
		);

		this._foundryManager = foundryManager;
	}

	private async _getFoundryModelInformation(modelId: string): Promise<{
		alias: string;
		displayName: string;
		modelId: string;
		version: string;
		fileSizeMb: number;
		supportsToolCalling: boolean;
		task: string;
	}> {
		if (!this._foundryManager) {
			throw new Error('Foundry Local manager not initialized');
		}

		const modelInfo = await this._foundryManager.getModelInfo(modelId);
		if (!modelInfo) {
			throw new Error(`Model ${modelId} not found`);
		}

		// Map the SDK's FoundryModelInfo to our expected format
		return {
			alias: modelInfo.alias || modelId,
			displayName: modelInfo.alias || modelId, // Use alias as display name since SDK doesn't have displayName
			modelId: modelInfo.id || modelId,
			version: modelInfo.version || '1.0.0',
			fileSizeMb: modelInfo.modelSize || 0,
			supportsToolCalling: true, // SDK doesn't expose this, we'll need to infer it
			task: modelInfo.task || 'chat-completion',
		};
	}

	override async getModelInfo(modelId: string, apiKey: string, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		if (this._modelCache.has(modelId)) {
			return this._modelCache.get(modelId)!;
		}

		if (!modelCapabilities) {
			const modelInfo = await this._getFoundryModelInformation(modelId);

			// Default context window - may need to be adjusted based on specific models
			// Foundry Local documentation doesn't specify context lengths per model
			const contextWindow = 4096; // Conservative default
			const outputTokens = Math.min(contextWindow / 2, 4096);

			// Infer vision capability from model name/alias if not explicitly available
			const hasVision = modelInfo.alias?.toLowerCase().includes('vision') ||
				modelInfo.displayName?.toLowerCase().includes('vision') ||
				modelInfo.task === 'multimodal' ||
				modelInfo.task === 'vision';

			modelCapabilities = {
				name: modelInfo.displayName,
				maxOutputTokens: outputTokens,
				maxInputTokens: contextWindow - outputTokens,
				vision: hasVision,
				toolCalling: modelInfo.supportsToolCalling
			};
		}

		return super.getModelInfo(modelId, apiKey, modelCapabilities);
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		if (!this._foundryManager) {
			throw new Error('Foundry Local manager not initialized');
		}

		try {
			// Check if service is running and start if needed
			await this._checkFoundryService();

			// Get available models from catalog
			const models = await this._foundryManager.listCatalogModels();
			const knownModels: BYOKKnownModels = {};

			for (const model of models) {
				const modelInfo = await this.getModelInfo(model.alias || model.id, '', undefined);
				this._modelCache.set(model.alias || model.id, modelInfo);
				knownModels[model.alias || model.id] = {
					maxInputTokens: modelInfo.capabilities.limits?.max_prompt_tokens ?? 4096,
					maxOutputTokens: modelInfo.capabilities.limits?.max_output_tokens ?? 4096,
					name: modelInfo.name,
					toolCalling: !!modelInfo.capabilities.supports.tool_calls,
					vision: !!modelInfo.capabilities.supports.vision
				};
			}
			return knownModels;
		} catch (e) {
			// Check if this is our service check error and preserve it
			if (e instanceof Error && e.message.includes('Foundry Local service')) {
				throw e;
			}
			throw new Error('Failed to fetch models from Foundry Local. Please ensure Foundry Local is installed and running. You can start the service with `foundry service start`.');
		}
	}

	/**
	 * Check if the Foundry Local service is running and accessible
	 * @throws Error if service is not accessible or version check fails
	 */
	private async _checkFoundryService(): Promise<void> {
		if (!this._foundryManager) {
			throw new Error('Foundry Local manager not initialized');
		}

		try {
			await this._foundryManager.startService();
			// Check if service is running
			const isRunning = await this._foundryManager.isServiceRunning();

			if (!isRunning) {
				throw new Error(
					'Foundry Local service is not running. ' +
					'Please start the service with `foundry service start` command. ' +
					'Make sure Foundry Local is installed and properly configured.'
				);
			}

			// Note: The Foundry Local SDK doesn't expose a direct version check method
			// We'll rely on service availability as the primary check
			// If version checking becomes critical, it could be added via direct REST API calls

		} catch (e) {
			if (e instanceof Error && e.message.includes('Foundry Local service')) {
				// Re-throw our custom service error
				throw e;
			}
			// If any other error occurs during service check
			throw new Error(
				`Unable to connect to Foundry Local service. ` +
				`Please ensure Foundry Local version ${MINIMUM_FOUNDRY_VERSION} or higher is installed and running. ` +
				`You can start the service with 'foundry service start'.`
			);
		}
	}
}
