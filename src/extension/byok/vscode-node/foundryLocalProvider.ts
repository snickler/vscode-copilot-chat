/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, ChatResponseFragment2, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelChatRequestHandleOptions, Progress } from 'vscode';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKAuthType, BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';
import { BaseOpenAICompatibleLMProvider } from './baseOpenAICompatibleProvider';
import { IBYOKStorageService } from './byokStorageService';
import { FoundryLocalEndpoint } from '../node/foundryLocalEndpoint';

// Foundry Local SDK
import { FoundryLocalManager, FoundryModelInfo } from 'foundry-local-sdk';

export class FoundryLocalLMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'FoundryLocal';
	private static readonly DEFAULT_SERVICE_URL = 'http://localhost:5273';
	private static readonly DEFAULT_CONTEXT_WINDOW = 4096;
	private static readonly DEFAULT_MAX_OUTPUT_TOKENS = 2048;
	
	private _modelCache = new Map<string, IChatModelInformation>();
	private _foundryManager: FoundryLocalManager;
	private _initialized = false;
	private _localApiKey: string | undefined;
	private _localBaseUrl: string;
	private _localLmWrapper: CopilotLanguageModelWrapper;
	private _localInstantiationService: IInstantiationService;

	constructor(
		foundryServiceUrl: string | undefined,
		byokStorageService: IBYOKStorageService,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		const serviceUrl = foundryServiceUrl || FoundryLocalLMProvider.DEFAULT_SERVICE_URL;
		
		super(
			BYOKAuthType.None,
			FoundryLocalLMProvider.providerName,
			`${serviceUrl}/v1`,
			undefined,
			byokStorageService,
			fetcherService,
			_logService,
			_instantiationService
		);

		// Store instance variables to avoid accessing private base class members
		this._localApiKey = undefined;
		this._localBaseUrl = `${serviceUrl}/v1`;
		this._localInstantiationService = _instantiationService;
		this._localLmWrapper = _instantiationService.createInstance(CopilotLanguageModelWrapper);

		// Initialize Foundry manager - will be properly initialized on first use
		this._foundryManager = new FoundryLocalManager();
		this._logService.info(`FoundryLocal provider initialized with service URL: ${serviceUrl}`);
	}

	/**
	 * Initialize the Foundry Local Manager on first use
	 */
	private async _ensureInitialized(): Promise<void> {
		if (this._initialized) {
			return;
		}

		this._logService.info('Initializing Foundry Local service...');
		
		try {
			await this._foundryManager.startService();
			await this._foundryManager.init(null);
			this._initialized = true;
			this._logService.info('Foundry Local service initialized successfully');
		} catch (error) {
			this._logService.error(`Failed to initialize Foundry Local service: ${error}`);
			throw new Error(
				'Failed to initialize Foundry Local service. ' +
				'Please ensure Foundry Local is installed and running. ' +
				'You can start it with "foundry local start".'
			);
		}
	}

	/**
	 * Get detailed information about a specific Foundry Local model using the SDK
	 */
	private async _getFoundryModelInformation(modelId: string): Promise<FoundryModelInfo> {
		await this._ensureInitialized();

		try {
			// Try to get the model info directly
			let modelInfo = await this._foundryManager.getModelInfo(modelId);
			
			// If model not found, try to initialize it first
			if (!modelInfo) {
				this._logService.info(`Model ${modelId} not loaded, attempting to initialize...`);
				await this._foundryManager.init(modelId);
				modelInfo = await this._foundryManager.getModelInfo(modelId);
			}

			if (!modelInfo) {
				throw new Error(`Model ${modelId} not found after initialization`);
			}

			return modelInfo;
		} catch (error) {
			this._logService.warn(`Failed to get model info for ${modelId}: ${error}`);
			throw new Error(
				`Unable to get information for model "${modelId}". ` +
				'Please ensure the model exists in the Foundry Local catalog. ' +
				'You can list available models with "foundry model list".'
			);
		}
	}

	/**
	 * Determines if a model supports thinking/reasoning based on its name or metadata
	 */
	private _isThinkingModel(modelId: string, modelInfo?: FoundryModelInfo): boolean {
		// Check model ID patterns
		const thinkingPatterns = ['reasoning', 'phi-4', 'think'];
		const modelIdLower = modelId.toLowerCase();
		
		if (thinkingPatterns.some(pattern => modelIdLower.includes(pattern))) {
			return true;
		}

		// Check model alias if available
		if (modelInfo?.alias) {
			const aliasLower = modelInfo.alias.toLowerCase();
			if (thinkingPatterns.some(pattern => aliasLower.includes(pattern))) {
				return true;
			}
		}

		return false;
	}

	override async getModelInfo(modelId: string, apiKey: string, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		await this._ensureInitialized();

		if (this._modelCache.has(modelId)) {
			return this._modelCache.get(modelId)!;
		}

		if (!modelCapabilities) {
			try {
				const modelInfo = await this._getFoundryModelInformation(modelId);

				// Determine capabilities from model information
				const contextWindow = FoundryLocalLMProvider.DEFAULT_CONTEXT_WINDOW;
				const maxOutputTokens = Math.min(contextWindow / 2, FoundryLocalLMProvider.DEFAULT_MAX_OUTPUT_TOKENS);

				// Infer vision support
				const hasVision = modelInfo.alias?.toLowerCase().includes('vision') ||
					modelInfo.task === 'multimodal' ||
					modelInfo.task === 'vision';

				// Most modern models support tool calling
				const hasToolCalling = true;

				// Check for thinking/reasoning capability
				const hasThinking = this._isThinkingModel(modelId, modelInfo);

				modelCapabilities = {
					name: modelInfo.alias || modelInfo.id,
					maxOutputTokens,
					maxInputTokens: contextWindow - maxOutputTokens,
					vision: hasVision,
					toolCalling: hasToolCalling,
					thinking: hasThinking
				};

				this._logService.info(
					`Model capabilities for ${modelId}: ` +
					`vision=${hasVision}, toolCalling=${hasToolCalling}, thinking=${hasThinking}`
				);
			} catch (error) {
				this._logService.warn(`Failed to get model info from Foundry Local for ${modelId}, using defaults: ${error}`);

				// Fallback capabilities with thinking detection
				const hasThinking = this._isThinkingModel(modelId);

				modelCapabilities = {
					name: modelId,
					maxOutputTokens: FoundryLocalLMProvider.DEFAULT_MAX_OUTPUT_TOKENS,
					maxInputTokens: FoundryLocalLMProvider.DEFAULT_MAX_OUTPUT_TOKENS,
					vision: false,
					toolCalling: true,
					thinking: hasThinking
				};

				this._logService.info(`Using fallback capabilities for ${modelId}: thinking=${hasThinking}`);
			}
		}

		const chatModelInfo = await super.getModelInfo(modelId, apiKey, modelCapabilities);
		this._modelCache.set(modelId, chatModelInfo);
		return chatModelInfo;
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		await this._ensureInitialized();

		try {
			const catalogModels = await this._foundryManager.listCatalogModels();
			const knownModels: BYOKKnownModels = {};

			if (!catalogModels || catalogModels.length === 0) {
				this._logService.warn('No models found in Foundry Local catalog');
				return {};
			}

			this._logService.info(`Found ${catalogModels.length} models in Foundry Local catalog`);

			for (const model of catalogModels) {
				try {
					const modelId = model.id;
					const hasThinking = this._isThinkingModel(modelId, model);

					this._logService.debug(`Processing model ${modelId}, hasThinking: ${hasThinking}`);

					const modelInfo = await this.getModelInfo(modelId, '', undefined);

					knownModels[modelId] = {
						maxInputTokens: modelInfo.capabilities.limits?.max_prompt_tokens ?? FoundryLocalLMProvider.DEFAULT_CONTEXT_WINDOW,
						maxOutputTokens: modelInfo.capabilities.limits?.max_output_tokens ?? FoundryLocalLMProvider.DEFAULT_MAX_OUTPUT_TOKENS,
						name: model.alias || modelId,
						toolCalling: !!modelInfo.capabilities.supports.tool_calls,
						vision: !!modelInfo.capabilities.supports.vision,
						thinking: hasThinking
					};
				} catch (error) {
					this._logService.warn(`Failed to get info for model ${model.id}: ${error}`);
					// Continue processing other models
				}
			}

			const processedCount = Object.keys(knownModels).length;
			if (processedCount === 0) {
				this._logService.warn('No valid models found from Foundry Local catalog');
			} else {
				this._logService.info(`Successfully processed ${processedCount} models from Foundry Local catalog`);
			}

			return knownModels;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this._logService.error(`Error fetching models from Foundry Local: ${errorMessage}`);

			if (errorMessage.includes('fetch') || errorMessage.includes('ECONNREFUSED')) {
				throw new Error(
					'Unable to connect to Foundry Local service. ' +
					'Please ensure Foundry Local is installed and running. ' +
					'You can start the service with "foundry local start".'
				);
			}

			throw new Error(
				`Failed to fetch models from Foundry Local: ${errorMessage}. ` +
				'Please ensure Foundry Local is properly installed and configured.'
			);
		}
	}

	override async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation, 
		messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, 
		options: LanguageModelChatRequestHandleOptions, 
		progress: Progress<ChatResponseFragment2>, 
		token: CancellationToken
	): Promise<any> {
		this._logService.info(`[FoundryLocal] Starting chat response for model: ${model.id}`);
		
		try {
			const modelInfo: IChatModelInformation = await this.getModelInfo(model.id, this._localApiKey || '');
			
			const foundryLocalEndpoint = this._localInstantiationService.createInstance(
				FoundryLocalEndpoint, 
				modelInfo, 
				this._localApiKey || '', 
				`${this._localBaseUrl}/chat/completions`
			);
			
			return this._localLmWrapper.provideLanguageModelResponse(foundryLocalEndpoint, messages, options, options.extensionId, progress, token);
		} catch (error) {
			this._logService.error(`[FoundryLocal] Error in provideLanguageModelChatResponse: ${error}`);
			throw error;
		}
	}

	/**
	 * Override to use custom FoundryLocalEndpoint for token counting
	 */
	override async provideTokenCount(
		model: LanguageModelChatInformation, 
		text: string | LanguageModelChatMessage | LanguageModelChatMessage2, 
		token: CancellationToken
	): Promise<number> {
		try {
			const modelInfo: IChatModelInformation = await this.getModelInfo(model.id, this._localApiKey || '');
			const foundryLocalEndpoint = this._localInstantiationService.createInstance(
				FoundryLocalEndpoint, 
				modelInfo, 
				this._localApiKey || '', 
				`${this._localBaseUrl}/chat/completions`
			);
			
			return this._localLmWrapper.provideTokenCount(foundryLocalEndpoint, text);
		} catch (error) {
			this._logService.error(`[FoundryLocal] Error in provideTokenCount: ${error}`);
			throw error;
		}
	}
}
