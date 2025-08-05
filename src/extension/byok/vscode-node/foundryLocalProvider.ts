/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FoundryLocalManager } from 'foundry-local-sdk';
import { CancellationToken, LanguageModelChatInformation } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';
import { BaseOpenAICompatibleLMProvider } from './baseOpenAICompatibleProvider';
import { IBYOKStorageService } from './byokStorageService';

export class FoundryLocalLMProvider extends BaseOpenAICompatibleLMProvider {
	static readonly providerName = 'FoundryLocal';
	private readonly _foundryManager: FoundryLocalManager;

	constructor(
		byokStorageService: IBYOKStorageService,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		// Initialize with no auth required, provider name, and default base URL
		super(
			BYOKAuthType.None,
			FoundryLocalLMProvider.providerName,
			'http://localhost:5273/v1', // Default base URL with /v1 - will be updated dynamically from SDK
			undefined, // Known models will be fetched dynamically
			byokStorageService,
			fetcherService,
			logService,
			instantiationService
		);
		// Initialize FoundryLocalManager with optional configuration (as per SDK docs)
		this._foundryManager = new FoundryLocalManager();
	}

	private async ensureServiceAndModel(alias?: string): Promise<void> {
		try {
			// Start Foundry Local service if not running
			await this._foundryManager.startService();
			const isRunning = await this._foundryManager.isServiceRunning();
			if (!isRunning) {
				throw new Error('Foundry Local service is not running. Please start the service with `foundry service start`.');
			}

			// Initialize with a model if provided - this is the proper SDK pattern
			if (alias) {
				// Use init() method as shown in documentation - this downloads and loads the model
				await this._foundryManager.init(alias);
			}

			// Set the API key in the base class - use the SDK's apiKey property
			const apiKey = this._foundryManager.apiKey || 'OPENAI_API_KEY'; // Default as per documentation
			(this as any)._apiKey = apiKey;

			// Update the base URL to use the actual endpoint from Foundry Manager
			// The endpoint includes /v1, and BaseOpenAICompatibleLMProvider appends /chat/completions
			// So we keep the /v1 to get the correct final URL: http://localhost:5273/v1/chat/completions
			const endpoint = this._foundryManager.endpoint; // e.g., "http://localhost:5273/v1"
			const baseUrl = endpoint; // Keep /v1 in the base URL
			this._logService.info(`Foundry Manager Endpoint: ${endpoint} -> Base URL: ${baseUrl}`);
			(this as any)._baseUrl = baseUrl;
		} catch (e) {
			this._logService.error(`FoundryLocalManager error: ${e}`);
			throw e;
		}
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		try {
			// Ensure service is running and base configuration is set
			await this.ensureServiceAndModel();

			// Get available models from Foundry Local catalog using SDK method
			const catalog = await this._foundryManager.listCatalogModels();
			const knownModels: BYOKKnownModels = {};

			for (const model of catalog) {
				// Use alias if available, otherwise use id (following SDK documentation pattern)
				const modelId = model.id;
				// Infer capabilities from model metadata
				const hasVision = model.task === 'multimodal' || model.task === 'vision' ||
					modelId.toLowerCase().includes('vision');

				// Conservative token limits - can be adjusted based on specific models
				const maxInputTokens = 4096;
				const maxOutputTokens = 4096;

				knownModels[modelId] = {
					name: model.alias,
					thinking: modelId.toLowerCase().includes('thinking') || modelId.toLowerCase().includes('reasoning'),
					url: model.uri, // Use model URL if available
					maxInputTokens,
					maxOutputTokens,
					vision: hasVision,
					toolCalling: true // Most modern models support tool calling
				};
			}

			return knownModels;
		} catch (e) {
			this._logService.error(`Error fetching Foundry Local models: ${e}`);
			throw new Error(`Failed to fetch models from Foundry Local. Please ensure Foundry Local is installed and running. You can start the service with 'foundry service start'.`);
		}
	}

	protected override async getModelInfo(modelId: string, apiKey: string | undefined, modelCapabilities?: BYOKModelCapabilities): Promise<any> {
		// Ensure the specific model is loaded using the init() method
		await this.ensureServiceAndModel(modelId);

		// Get model info from Foundry Local using correct SDK signature
		const modelInfo = await this._foundryManager.getModelInfo(modelId, false); // throwOnNotFound = false
		if (!modelInfo) {
			throw new Error(`Model ${modelId} not found in Foundry Local catalog.`);
		}

		// Use base class method with Foundry Local specific capabilities
		if (!modelCapabilities) {
			const hasVision = modelInfo.task === 'multimodal' || modelInfo.task === 'vision' ||
				modelId.toLowerCase().includes('vision');

			modelCapabilities = {
				name: modelId,
				maxInputTokens: 4096,
				maxOutputTokens: 4096,
				vision: hasVision,
				toolCalling: true
			};
		}

		// Use the API key from FoundryLocalManager, fallback to provided apiKey
		const foundryApiKey = this._foundryManager.apiKey || apiKey || 'OPENAI_API_KEY'; // Default as per documentation
		return super.getModelInfo(modelId, foundryApiKey, modelCapabilities);
	}

	override async prepareLanguageModelChat(options: { silent: boolean }, token: CancellationToken): Promise<LanguageModelChatInformation[]> {
		try {
			// Ensure service is running and get models
			await this.ensureServiceAndModel();
			return super.prepareLanguageModelChat(options, token);
		} catch (e) {
			this._logService.error(`prepareLanguageModelChat error: ${e}`);
			return [];
		}
	}
}
