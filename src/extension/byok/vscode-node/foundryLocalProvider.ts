/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import {
	CancellationToken,
	ChatResponseFragment2,
	LanguageModelChatInformation,
	LanguageModelChatMessage,
	LanguageModelChatMessage2,
	LanguageModelChatRequestHandleOptions,
	LanguageModelTextPart,
	Progress
} from 'vscode';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService'; // Still injected for consistency (e.g. proxy/auth headers) but no custom wrapper
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKAuthType, BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';
import { BaseOpenAICompatibleLMProvider } from './baseOpenAICompatibleProvider';
import { IBYOKStorageService } from './byokStorageService';

// Foundry Local SDK
import { FoundryLocalManager, FoundryModelInfo } from 'foundry-local-sdk';

export class FoundryLocalLMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'FoundryLocal';
	private _modelCache = new Map<string, IChatModelInformation>();
	private _foundryManager!: FoundryLocalManager;
	private _initialized = false;
	private _serviceUrl: string | undefined;

	constructor(
		foundryServiceUrl: string | undefined,
		byokStorageService: IBYOKStorageService,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		// Determine initial service URL BEFORE calling super
		const initialServiceUrl = foundryServiceUrl || 'http://localhost:5273';
		super(
			BYOKAuthType.None,
			FoundryLocalLMProvider.providerName,
			`${initialServiceUrl}/v1`,
			undefined,
			byokStorageService,
			fetcherService,
			_logService,
			_instantiationService
		);
		this._serviceUrl = initialServiceUrl;
		this._logService.info(`Using Foundry Local service URL (initial): ${initialServiceUrl}`);
		this._foundryManager = new FoundryLocalManager();
	}

	/**
	 * Initialize the Foundry Local Manager for model information
	 */
	private async _ensureManagerStarted(): Promise<void> {
		if (this._initialized) { return; }
		this._logService.info('Starting Foundry Local service (if not already running)...');
		await this._foundryManager.startService();
		// Light-weight init without forcing a model load yet
		await this._foundryManager.init(null);
		// Capture discovered endpoint if available
		if (!this._serviceUrl && (this._foundryManager as any).endpoint) {
			this._serviceUrl = (this._foundryManager as any).endpoint;
			this._logService.info(`Discovered Foundry Local endpoint: ${this._serviceUrl}`);
		}
		this._initialized = true;
	}

	/**
	 * Ensure the Foundry Local Manager is initialized before making requests
	 */
	private async _ensureInitialized(): Promise<void> { return this._ensureManagerStarted(); }

	/**
	 * Check if Foundry Local service is healthy and accessible
	 */
	private async _checkServiceHealth(): Promise<void> {
		await this._ensureInitialized();
		try {
			await this._foundryManager.listCatalogModels();
		} catch (error) {
			throw new Error('Foundry Local service is not reachable. Ensure it is running ("foundry local start").');
		}
	}

	/**
	 * Helper method to detect reasoning models by name patterns
	 */
	// (Reasoning model detection removed for simplicity; can be reintroduced if needed.)

	/**
	 * Override to use our custom FetcherService that fixes Foundry Local's streaming format
	 */
	override async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
		_options: LanguageModelChatRequestHandleOptions,
		progress: Progress<ChatResponseFragment2>,
		token: CancellationToken
	): Promise<any> {
		this._logService.info(`[FoundryLocal] Streaming chat start model=${model.id}`);
		await this._checkServiceHealth();
		// Ensure the target model is available (lightweight: try to fetch info; if fails, attempt init by alias/id)
		try {
			await this._foundryManager.getModelInfo(model.id);
		} catch {
			try {
				this._logService.info(`[FoundryLocal] Model ${model.id} not loaded. Attempting init...`);
				await this._foundryManager.init(model.id);
			} catch (e) {
				this._logService.warn(`[FoundryLocal] Unable to init model ${model.id}: ${e}`);
			}
		}
		const endpoint = (this._foundryManager as any).endpoint || this._serviceUrl || 'http://localhost:5273';
		const url = `${endpoint}/chat/completions`;
		// Normalize messages: flatten parts to plain string content
		const roleMap: Record<string | number, string> = { 0: 'system', 1: 'user', 2: 'assistant', 3: 'tool', system: 'system', user: 'user', assistant: 'assistant', tool: 'tool' };
		const mapped = messages.map(m => {
			const anyM = m as any;
			let role: any = anyM.role;
			let content: any = anyM.content;
			if (Array.isArray(content)) { content = content.map((p: any) => p.value ?? p.text ?? p).join(''); }
			else if (typeof content === 'object' && content !== null) { content = content.value ?? content.text ?? ''; }
			if (roleMap[role] === undefined) { role = 'user'; } else { role = roleMap[role]; }
			return { role, content: String(content ?? '') };
		});
		const body = JSON.stringify({ model: model.id, messages: mapped, stream: true });
		this._logService.info(`[FoundryLocal] POST ${url}`);
		// Use global fetch (electron environment) for simplicity. If token cancellation requested, abort.
		const abortCtrl = new AbortController();
		token.onCancellationRequested(() => abortCtrl.abort());
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
			body,
			signal: abortCtrl.signal
		});
		if (!response.ok) {
			throw new Error(`[FoundryLocal] HTTP ${response.status} ${response.statusText}`);
		}
		const stream = (response as any).body;
		if (!stream || typeof stream.getReader !== 'function') {
			throw new Error('[FoundryLocal] Response body is not a readable stream');
		}
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let accumulated = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) { break; }
			if (!value) { continue; }
			const chunk = decoder.decode(value, { stream: true });
			const lines = chunk.split('\n').filter(l => l.trim() !== '');
			for (const line of lines) {
				if (!line.startsWith('data: ')) { continue; }
				const data = line.substring(6);
				if (data === '[DONE]') { continue; }
				try {
					const json = JSON.parse(data);
					const delta = json.choices?.[0]?.delta?.content || '';
					if (delta) {
						accumulated += delta;
						progress.report({ index: 0, part: new LanguageModelTextPart(delta) });
					}
				} catch (e) {
					this._logService.warn(`[FoundryLocal] Failed to parse SSE line: ${e}`);
				}
			}
		}
		this._logService.info('[FoundryLocal] Streaming complete');
		return undefined; // Output already streamed
	}

	/**
	 * Get detailed information about a specific Foundry Local model using the SDK
	 */
	private async _getFoundryModelInformation(modelId: string): Promise<FoundryModelInfo> {
		await this._ensureInitialized();

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
		await this._ensureInitialized();

		if (this._modelCache.has(modelId)) {
			return this._modelCache.get(modelId)!;
		}

		if (!modelCapabilities) {
			try {
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

				// Check if this is a reasoning model (like phi-4-mini-reasoning)
				const isReasoningModel = modelId.toLowerCase().includes('reasoning') ||
					modelId.toLowerCase().includes('phi-4');

				// Enable streaming with our custom fetcher service that fixes the format issue
				const enableStreaming = true; // Re-enabled with proper custom FetcherService injection

				modelCapabilities = {
					name: modelInfo.alias || modelInfo.id,
					maxOutputTokens: outputTokens,
					maxInputTokens: contextWindow - outputTokens,
					vision: hasVision,
					toolCalling: hasToolCalling,
					// Add reasoning capability if this is a reasoning model
					thinking: isReasoningModel
				};

				this._logService.info(`Model capabilities for ${modelId}: vision=${hasVision}, toolCalling=${hasToolCalling}, thinking=${isReasoningModel}, streaming=${enableStreaming}`);
			} catch (error) {
				this._logService.warn(`Failed to get model info from Foundry Local for ${modelId}, using defaults: ${error}`);

				// Fallback to basic capabilities with reasoning detection
				const isReasoningModel = modelId.toLowerCase().includes('reasoning') ||
					modelId.toLowerCase().includes('phi-4');

				// Enable streaming with our custom fetcher service that fixes the format issue
				const enableStreaming = true; // Re-enabled with proper custom FetcherService injection

				modelCapabilities = {
					name: modelId,
					maxOutputTokens: 2048,
					maxInputTokens: 2048,
					vision: false,
					toolCalling: true,
					thinking: isReasoningModel
				};

				this._logService.info(`Using fallback capabilities for ${modelId}: thinking=${isReasoningModel}, streaming=${enableStreaming}`);
			}
		}

		const chatModelInfo = await super.getModelInfo(modelId, apiKey, modelCapabilities);
		this._modelCache.set(modelId, chatModelInfo);
		return chatModelInfo;
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		await this._ensureInitialized();

		try {
			// Use SDK to get available models from the catalog
			const catalogModels = await this._foundryManager.listCatalogModels();
			const knownModels: BYOKKnownModels = {};

			if (!catalogModels || catalogModels.length === 0) {
				this._logService.warn('No models found in Foundry Local catalog');
				return {};
			}

			this._logService.info(`Found ${catalogModels.length} models in Foundry Local catalog`);

			for (const model of catalogModels) {
				try {
					// Use the model ID for lookup
					const modelId = model.id;

					// Check if this is a reasoning model
					const isReasoningModel = modelId.toLowerCase().includes('reasoning') ||
						modelId.toLowerCase().includes('phi-4');

					this._logService.info(`Processing model ${modelId}, isReasoningModel: ${isReasoningModel}`);

					const modelInfo = await this.getModelInfo(modelId, '', undefined);

					knownModels[modelId] = {
						maxInputTokens: modelInfo.capabilities.limits?.max_prompt_tokens ?? 4096,
						maxOutputTokens: modelInfo.capabilities.limits?.max_output_tokens ?? 2048,
						name: model.alias || modelId,
						toolCalling: !!modelInfo.capabilities.supports.tool_calls,
						vision: !!modelInfo.capabilities.supports.vision,
						thinking: isReasoningModel
					};
				} catch (error) {
					// If we can't get info for a specific model, log and continue
					this._logService.warn(`Failed to get info for model ${model.id}: ${error}`);
				}
			}

			if (Object.keys(knownModels).length === 0) {
				this._logService.warn('No valid models found from Foundry Local catalog');
			} else {
				this._logService.info(`Successfully processed ${Object.keys(knownModels).length} models from Foundry Local catalog`);
			}

			return knownModels;
		} catch (error) {
			// Provide helpful error message based on the error type
			const errorMessage = error instanceof Error ? error.message : String(error);

			this._logService.error(`Error fetching models from Foundry Local: ${errorMessage}`);

			if (errorMessage.includes('fetch') || errorMessage.includes('ECONNREFUSED')) {
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
