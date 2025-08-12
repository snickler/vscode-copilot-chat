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
import { FoundryLocalManager, FoundryModelInfo } from 'foundry-local-sdk';

export class FoundryLocalLMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'FoundryLocal';
	private _modelCache = new Map<string, IChatModelInformation>();
	private _foundryManager: FoundryLocalManager;

	constructor(
		foundryServiceUrl: string | undefined,
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		// Create Foundry manager based on environment
		// For browser environments or when a specific URL is provided, use the browser version
		// For Node.js environments without URL, use auto-discovery
		let foundryManager: FoundryLocalManager;
		
		if (foundryServiceUrl) {
			// Use browser-compatible version with explicit service URL
			const { FoundryLocalManager: BrowserFoundryLocalManager } = require('foundry-local-sdk/browser');
			foundryManager = new BrowserFoundryLocalManager({ 
				serviceUrl: foundryServiceUrl,
				fetch: _fetcherService.fetch.bind(_fetcherService)
			});
		} else {
			// Use Node.js version with auto-discovery
			foundryManager = new FoundryLocalManager({
				fetch: _fetcherService.fetch.bind(_fetcherService)
			});
		}

		super(
			BYOKAuthType.None,
			FoundryLocalLMProvider.providerName,
			foundryManager.endpoint, // Use SDK-provided endpoint
			undefined,
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService
		);

		this._foundryManager = foundryManager;
	}

	/**
	 * Get detailed information about a specific Foundry Local model using the SDK
	 */
	private async _getFoundryModelInformation(modelId: string): Promise<FoundryModelInfo> {
		try {
			const modelInfo = await this._foundryManager.getModelInfo(modelId);
			if (!modelInfo) {
				throw new Error(`Model ${modelId} not found in Foundry Local catalog`);
			}
			return modelInfo;
		} catch (error) {
			this._logService.warn(`Failed to get model info for ${modelId}: ${error}`);
			throw new Error(
				`Unable to get information for model "${modelId}". ` +
				'Please ensure the model exists in the Foundry Local catalog. ' +
				'You can list available models with `foundry model list`.'
			);
		}
	}

	override async getModelInfo(modelId: string, apiKey: string, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		if (this._modelCache.has(modelId)) {
			return this._modelCache.get(modelId)!;
		}

		if (!modelCapabilities) {
			const modelInfo = await this._getFoundryModelInformation(modelId);

			// Default context window - Foundry Local models vary in their context lengths
			// Use a conservative default, but this could be improved by checking model-specific info
			const contextWindow = 4096; // Conservative default
			const outputTokens = Math.min(contextWindow / 2, 2048);

			// Infer capabilities from model information
			const hasVision = modelInfo.alias?.toLowerCase().includes('vision') ||
				modelInfo.task === 'multimodal' ||
				modelInfo.task === 'vision';

			// For tool calling support, we'll assume models support it unless we know otherwise
			// The SDK doesn't explicitly expose this capability yet
			const hasToolCalling = true;

			modelCapabilities = {
				name: modelInfo.alias || modelInfo.id,
				maxOutputTokens: outputTokens,
				maxInputTokens: contextWindow - outputTokens,
				vision: hasVision,
				toolCalling: hasToolCalling
			};
		}

		const chatModelInfo = await super.getModelInfo(modelId, apiKey, modelCapabilities);
		this._modelCache.set(modelId, chatModelInfo);
		return chatModelInfo;
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		try {
			// Use SDK to get available models from the catalog
			const catalogModels = await this._foundryManager.listCatalogModels();
			const knownModels: BYOKKnownModels = {};

			if (!catalogModels || catalogModels.length === 0) {
				this._logService.warn('No models found in Foundry Local catalog');
				return {};
			}

			for (const model of catalogModels) {
				try {
					// Use the model ID for lookup
					const modelId = model.id;
					const modelInfo = await this.getModelInfo(modelId, '', undefined);
					
					knownModels[modelId] = {
						maxInputTokens: modelInfo.capabilities.limits?.max_prompt_tokens ?? 4096,
						maxOutputTokens: modelInfo.capabilities.limits?.max_output_tokens ?? 2048,
						name: model.alias || modelId,
						toolCalling: !!modelInfo.capabilities.supports.tool_calls,
						vision: !!modelInfo.capabilities.supports.vision
					};
				} catch (error) {
					// If we can't get info for a specific model, log and continue
					this._logService.warn(`Failed to get info for model ${model.id}: ${error}`);
				}
			}

			if (Object.keys(knownModels).length === 0) {
				this._logService.warn('No valid models found from Foundry Local catalog');
			}

			return knownModels;
		} catch (error) {
			// Provide helpful error message based on the error type
			const errorMessage = error instanceof Error ? error.message : String(error);
			
			if (errorMessage.includes('fetch')) {
				throw new Error(
					'Unable to connect to Foundry Local service. Please ensure Foundry Local is installed and running. ' +
					'You can start the service with `foundry local start` or check the Foundry Local documentation for setup instructions.'
				);
			}
			
			throw new Error(
				`Failed to fetch models from Foundry Local: ${errorMessage}. ` +
				'Please ensure Foundry Local is properly installed and configured.'
			);
		}
	}

}
