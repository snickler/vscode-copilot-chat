/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect, beforeEach, vi, MockedFunction } from 'vitest';
import { FoundryLocalLMProvider } from '../foundryLocalProvider';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IBYOKStorageService } from '../byokStorageService';

// Mock the foundry-local-sdk
vi.mock('foundry-local-sdk', () => ({
	FoundryLocalManager: vi.fn().mockImplementation((options?: any) => ({
		endpoint: options?.serviceUrl ? `${options.serviceUrl}/v1` : 'http://localhost:5273/v1',
		apiKey: 'foundry-local',
		listCatalogModels: vi.fn(),
		getModelInfo: vi.fn()
	}))
}));

// Mock the browser version
vi.mock('foundry-local-sdk/browser', () => ({
	FoundryLocalManager: vi.fn().mockImplementation((options: any) => ({
		endpoint: `${options.serviceUrl}/v1`,
		apiKey: 'foundry-local',
		listCatalogModels: vi.fn(),
		getModelInfo: vi.fn()
	}))
}));

describe('FoundryLocalLMProvider', () => {
	let provider: FoundryLocalLMProvider;
	let mockFetcherService: Partial<IFetcherService>;
	let mockLogService: Partial<ILogService>;
	let mockInstantiationService: Partial<IInstantiationService>;
	let mockStorageService: Partial<IBYOKStorageService>;
	let mockFetch: MockedFunction<any>;

	beforeEach(() => {
		mockFetch = vi.fn();
		mockFetcherService = {
			fetch: mockFetch
		};
		
		mockLogService = {
			warn: vi.fn(),
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn()
		};

		mockInstantiationService = {
			createInstance: vi.fn()
		};

		mockStorageService = {};
	});

	describe('constructor', () => {
		it('should use Node.js SDK when no URL provided', () => {
			provider = new FoundryLocalLMProvider(
				undefined, // Use default/auto-discovery
				mockStorageService as IBYOKStorageService,
				mockFetcherService as IFetcherService,
				mockLogService as ILogService,
				mockInstantiationService as IInstantiationService
			);
			
			expect(provider).toBeDefined();
			expect(FoundryLocalLMProvider.providerName).toBe('FoundryLocal');
		});

		it('should use browser SDK when URL provided', () => {
			const customUrl = 'http://custom-host:8080';
			provider = new FoundryLocalLMProvider(
				customUrl,
				mockStorageService as IBYOKStorageService,
				mockFetcherService as IFetcherService,
				mockLogService as ILogService,
				mockInstantiationService as IInstantiationService
			);
			
			expect(provider).toBeDefined();
		});
	});

	describe('getModelInfo', () => {
		beforeEach(() => {
			provider = new FoundryLocalLMProvider(
				undefined,
				mockStorageService as IBYOKStorageService,
				mockFetcherService as IFetcherService,
				mockLogService as ILogService,
				mockInstantiationService as IInstantiationService
			);
		});

		it('should get model info from SDK and cache it', async () => {
			const mockModelInfo = {
				id: 'test-model-id',
				alias: 'test-model',
				version: '1.0.0',
				task: 'chat',
				modelSize: 1024,
				uri: 'test-uri',
				runtime: 'CPU',
				promptTemplate: {},
				provider: 'test',
				publisher: 'test',
				license: 'MIT'
			};

			// Mock the SDK's getModelInfo method
			const mockFoundryManager = (provider as any)._foundryManager;
			mockFoundryManager.getModelInfo = vi.fn().mockResolvedValue(mockModelInfo);

			// Mock the super.getModelInfo method
			const mockSuperGetModelInfo = vi.fn().mockResolvedValue({
				name: 'test-model',
				capabilities: {
					limits: {
						max_prompt_tokens: 4096,
						max_output_tokens: 2048
					},
					supports: {
						tool_calls: true,
						vision: false
					}
				}
			});
			Object.setPrototypeOf(provider, {
				...Object.getPrototypeOf(provider),
				getModelInfo: mockSuperGetModelInfo
			});

			const result = await provider.getModelInfo('test-model-id', '');

			expect(mockFoundryManager.getModelInfo).toHaveBeenCalledWith('test-model-id');
			expect(result).toBeDefined();
		});

		it('should handle model not found error', async () => {
			const mockFoundryManager = (provider as any)._foundryManager;
			mockFoundryManager.getModelInfo = vi.fn().mockResolvedValue(null);

			await expect(provider.getModelInfo('nonexistent-model', '')).rejects.toThrow(
				'Unable to get information for model "nonexistent-model"'
			);
		});
	});

	describe('getAllModels', () => {
		beforeEach(() => {
			provider = new FoundryLocalLMProvider(
				undefined,
				mockStorageService as IBYOKStorageService,
				mockFetcherService as IFetcherService,
				mockLogService as ILogService,
				mockInstantiationService as IInstantiationService
			);
		});

		it('should return models from SDK catalog', async () => {
			const mockCatalogModels = [
				{
					id: 'model1',
					alias: 'Model 1',
					version: '1.0.0',
					task: 'chat',
					modelSize: 1024,
					uri: 'uri1',
					runtime: 'CPU',
					promptTemplate: {},
					provider: 'test',
					publisher: 'test',
					license: 'MIT'
				},
				{
					id: 'model2',
					alias: 'Model 2',
					version: '1.0.0',
					task: 'vision',
					modelSize: 2048,
					uri: 'uri2',
					runtime: 'GPU',
					promptTemplate: {},
					provider: 'test',
					publisher: 'test',
					license: 'MIT'
				}
			];

			const mockFoundryManager = (provider as any)._foundryManager;
			mockFoundryManager.listCatalogModels = vi.fn().mockResolvedValue(mockCatalogModels);

			// Mock getModelInfo for each model
			const mockGetModelInfo = vi.fn();
			mockGetModelInfo.mockResolvedValueOnce({
				capabilities: {
					limits: { max_prompt_tokens: 4096, max_output_tokens: 2048 },
					supports: { tool_calls: true, vision: false }
				}
			});
			mockGetModelInfo.mockResolvedValueOnce({
				capabilities: {
					limits: { max_prompt_tokens: 8192, max_output_tokens: 4096 },
					supports: { tool_calls: false, vision: true }
				}
			});
			provider.getModelInfo = mockGetModelInfo;

			const result = await provider.getAllModels();

			expect(mockFoundryManager.listCatalogModels).toHaveBeenCalled();
			expect(result).toEqual({
				'model1': {
					maxInputTokens: 4096,
					maxOutputTokens: 2048,
					name: 'Model 1',
					toolCalling: true,
					vision: false
				},
				'model2': {
					maxInputTokens: 8192,
					maxOutputTokens: 4096,
					name: 'Model 2',
					toolCalling: false,
					vision: true
				}
			});
		});

		it('should handle empty catalog gracefully', async () => {
			const mockFoundryManager = (provider as any)._foundryManager;
			mockFoundryManager.listCatalogModels = vi.fn().mockResolvedValue([]);

			const result = await provider.getAllModels();

			expect(result).toEqual({});
			expect(mockLogService.warn).toHaveBeenCalledWith('No models found in Foundry Local catalog');
		});

		it('should handle SDK errors gracefully', async () => {
			const mockFoundryManager = (provider as any)._foundryManager;
			mockFoundryManager.listCatalogModels = vi.fn().mockRejectedValue(new Error('fetch failed'));

			await expect(provider.getAllModels()).rejects.toThrow(
				'Unable to connect to Foundry Local service'
			);
		});
	});
});