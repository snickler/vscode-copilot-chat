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
	FoundryLocalManager: vi.fn().mockImplementation(() => ({
		startService: vi.fn().mockResolvedValue(undefined),
		init: vi.fn().mockResolvedValue(undefined),
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

	beforeEach(() => {
		mockFetcherService = {
			fetch: vi.fn()
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
		it('should initialize with default service URL when none provided', () => {
			provider = new FoundryLocalLMProvider(
				undefined,
				mockStorageService as IBYOKStorageService,
				mockFetcherService as IFetcherService,
				mockLogService as ILogService,
				mockInstantiationService as IInstantiationService
			);
			
			expect(provider).toBeDefined();
			expect(FoundryLocalLMProvider.providerName).toBe('FoundryLocal');
		});

		it('should initialize with custom service URL when provided', () => {
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

			// Mock the SDK methods
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
						vision: false,
						thinking: false
					}
				}
			});
			Object.setPrototypeOf(provider, {
				...Object.getPrototypeOf(provider),
				getModelInfo: mockSuperGetModelInfo
			});

			const result = await provider.getModelInfo('test-model-id', '');

			expect(result).toBeDefined();
		});

		it('should detect thinking models correctly', async () => {
			const mockModelInfo = {
				id: 'phi-4-mini-reasoning',
				alias: 'Phi-4 Reasoning',
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

			const mockFoundryManager = (provider as any)._foundryManager;
			mockFoundryManager.getModelInfo = vi.fn().mockResolvedValue(mockModelInfo);

			// Mock the super.getModelInfo to verify thinking capability is passed
			const mockSuperGetModelInfo = vi.fn().mockResolvedValue({
				name: 'Phi-4 Reasoning',
				capabilities: {
					limits: { max_prompt_tokens: 4096, max_output_tokens: 2048 },
					supports: { tool_calls: true, vision: false, thinking: true }
				}
			});
			Object.setPrototypeOf(provider, {
				...Object.getPrototypeOf(provider),
				getModelInfo: mockSuperGetModelInfo
			});

			await provider.getModelInfo('phi-4-mini-reasoning', '');

			// Verify that thinking capability was detected and passed to super
			expect(mockSuperGetModelInfo).toHaveBeenCalledWith(
				'phi-4-mini-reasoning',
				'',
				expect.objectContaining({
					thinking: true
				})
			);
		});

		it('should handle model not found error gracefully', async () => {
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
					id: 'phi-4-reasoning',
					alias: 'Phi-4 Reasoning',
					version: '1.0.0',
					task: 'chat',
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
					supports: { tool_calls: true, vision: false, thinking: false }
				}
			});
			mockGetModelInfo.mockResolvedValueOnce({
				capabilities: {
					limits: { max_prompt_tokens: 8192, max_output_tokens: 4096 },
					supports: { tool_calls: true, vision: false, thinking: true }
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
					vision: false,
					thinking: false
				},
				'phi-4-reasoning': {
					maxInputTokens: 8192,
					maxOutputTokens: 4096,
					name: 'Phi-4 Reasoning',
					toolCalling: true,
					vision: false,
					thinking: true
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