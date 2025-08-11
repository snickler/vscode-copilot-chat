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

// Foundry Local API response interfaces
interface FoundryLocalModelResponse {
	id: string;
	object: string;
	owned_by: string;
}

interface FoundryLocalModelsResponse {
	object: string;
	data: FoundryLocalModelResponse[];
}

interface FoundryLocalModelDetails {
	id: string;
	name?: string;
	description?: string;
	capabilities?: string[];
	context_length?: number;
	max_tokens?: number;
}

interface FoundryLocalHealthResponse {
	status: string;
	version?: string;
}

// Minimum supported Foundry Local version - versions below this may have compatibility issues
const MINIMUM_FOUNDRY_VERSION = '1.0.0';

export class FoundryLocalLMProvider extends BaseOpenAICompatibleLMProvider {
	public static readonly providerName = 'FoundryLocal';
	private _modelCache = new Map<string, IChatModelInformation>();
	private readonly _foundryBaseUrl: string;

	constructor(
		foundryServiceUrl: string | undefined,
		byokStorageService: IBYOKStorageService,
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService _logService: ILogService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		// Use provided URL or default to localhost
		const baseUrl = foundryServiceUrl || 'http://localhost:5273';
		
		super(
			BYOKAuthType.None,
			FoundryLocalLMProvider.providerName,
			`${baseUrl}/v1`, // OpenAI-compatible endpoint
			undefined,
			byokStorageService,
			_fetcherService,
			_logService,
			_instantiationService
		);

		this._foundryBaseUrl = baseUrl;
	}

	/**
	 * Get detailed information about a specific Foundry Local model
	 */
	private async _getFoundryModelDetails(modelId: string): Promise<FoundryLocalModelDetails> {
		try {
			// Try to get model details from a model-specific endpoint
			const response = await this._fetcherService.fetch(`${this._foundryBaseUrl}/api/models/${modelId}`, {
				method: 'GET',
				headers: {
					'Content-Type': 'application/json'
				}
			});

			if (!response.ok) {
				// If model-specific endpoint doesn't exist, return basic info
				return {
					id: modelId,
					name: modelId,
					context_length: 4096,
					max_tokens: 2048
				};
			}

			const details = await response.json() as FoundryLocalModelDetails;
			return details;
		} catch (error) {
			// Fallback to basic model info if detailed info isn't available
			this._logService.warn(`Failed to get detailed info for model ${modelId}: ${error}`);
			return {
				id: modelId,
				name: modelId,
				context_length: 4096,
				max_tokens: 2048
			};
		}
	}

	override async getModelInfo(modelId: string, apiKey: string, modelCapabilities?: BYOKModelCapabilities): Promise<IChatModelInformation> {
		if (this._modelCache.has(modelId)) {
			return this._modelCache.get(modelId)!;
		}

		if (!modelCapabilities) {
			const modelDetails = await this._getFoundryModelDetails(modelId);

			// Use model-specific context length or default
			const contextWindow = modelDetails.context_length || 4096;
			const outputTokens = modelDetails.max_tokens || Math.min(contextWindow / 2, 2048);

			// Infer capabilities from model details
			const capabilities = modelDetails.capabilities || [];
			const hasVision = capabilities.includes('vision') || 
				modelDetails.name?.toLowerCase().includes('vision') ||
				modelId.toLowerCase().includes('vision');
			
			const hasToolCalling = capabilities.includes('tools') || 
				capabilities.includes('function_calling') ||
				capabilities.includes('tool_calling');

			modelCapabilities = {
				name: modelDetails.name || modelId,
				maxOutputTokens: outputTokens,
				maxInputTokens: contextWindow - outputTokens,
				vision: hasVision,
				toolCalling: hasToolCalling
			};
		}

		return super.getModelInfo(modelId, apiKey, modelCapabilities);
	}

	protected override async getAllModels(): Promise<BYOKKnownModels> {
		try {
			// Check if service is running first
			await this._checkFoundryService();

			// Get available models from the OpenAI-compatible models endpoint
			const response = await this._fetcherService.fetch(`${this._foundryBaseUrl}/v1/models`, {
				method: 'GET',
				headers: {
					'Content-Type': 'application/json'
				}
			});

			if (!response.ok) {
				throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
			}

			const modelsResponse = await response.json() as FoundryLocalModelsResponse;
			const knownModels: BYOKKnownModels = {};

			for (const model of modelsResponse.data) {
				try {
					const modelInfo = await this.getModelInfo(model.id, '', undefined);
					this._modelCache.set(model.id, modelInfo);
					knownModels[model.id] = {
						maxInputTokens: modelInfo.capabilities.limits?.max_prompt_tokens ?? 4096,
						maxOutputTokens: modelInfo.capabilities.limits?.max_output_tokens ?? 2048,
						name: modelInfo.name,
						toolCalling: !!modelInfo.capabilities.supports.tool_calls,
						vision: !!modelInfo.capabilities.supports.vision
					};
				} catch (error) {
					// If we can't get info for a specific model, log and continue
					this._logService.warn(`Failed to get info for model ${model.id}: ${error}`);
				}
			}

			return knownModels;
		} catch (e) {
			// Check if this is our service check error and preserve it
			if (e instanceof Error && e.message.includes('Foundry Local service')) {
				throw e;
			}
			throw new Error(
				'Failed to fetch models from Foundry Local. Please ensure Foundry Local is installed and running. ' +
				'You can start the service with `foundry local start` or check the Foundry Local documentation for setup instructions.'
			);
		}
	}

	/**
	 * Check if the Foundry Local service is running and accessible
	 * @throws Error if service is not accessible or version check fails
	 */
	private async _checkFoundryService(): Promise<void> {
		try {
			// Try to check service health/status
			const healthResponse = await this._fetcherService.fetch(`${this._foundryBaseUrl}/health`, {
				method: 'GET',
				headers: {
					'Content-Type': 'application/json'
				}
			});

			if (healthResponse.ok) {
				const healthData = await healthResponse.json() as FoundryLocalHealthResponse;
				if (healthData.status !== 'ok' && healthData.status !== 'healthy') {
					throw new Error('Foundry Local service is not healthy');
				}
				return; // Service is healthy
			}
		} catch (healthError) {
			// Health endpoint might not exist, try a basic models endpoint check
			try {
				const modelsResponse = await this._fetcherService.fetch(`${this._foundryBaseUrl}/v1/models`, {
					method: 'GET',
					headers: {
						'Content-Type': 'application/json'
					}
				});

				if (modelsResponse.ok) {
					return; // Service responds to models endpoint
				}
			} catch (modelsError) {
				// Both health and models endpoints failed
				throw new Error(
					'Foundry Local service is not running or not accessible. ' +
					'Please start the service with `foundry local start` command. ' +
					'Make sure Foundry Local is installed and properly configured. ' +
					`Check that the service is running on ${this._foundryBaseUrl}.`
				);
			}
		}

		// If we get here, service responded but not with expected data
		throw new Error(
			`Foundry Local service at ${this._foundryBaseUrl} is not responding correctly. ` +
			'Please check your Foundry Local installation and configuration.'
		);
	}

	/**
	 * Compare version strings to check if current version meets minimum requirements
	 */
	private _isVersionSupported(currentVersion: string): boolean {
		const currentParts = currentVersion.split('.').map(n => parseInt(n, 10));
		const minimumParts = MINIMUM_FOUNDRY_VERSION.split('.').map(n => parseInt(n, 10));

		for (let i = 0; i < Math.max(currentParts.length, minimumParts.length); i++) {
			const current = currentParts[i] || 0;
			const minimum = minimumParts[i] || 0;

			if (current > minimum) {
				return true;
			}
			if (current < minimum) {
				return false;
			}
		}

		return true; // versions are equal
	}
}
