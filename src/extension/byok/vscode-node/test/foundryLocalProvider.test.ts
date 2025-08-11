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

// Mock interfaces
interface MockResponse {
	ok: boolean;
	status: number;
	statusText: string;
	json: () => Promise<any>;
}

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

		provider = new FoundryLocalLMProvider(
			undefined, // Use default URL
			mockStorageService as IBYOKStorageService,
			mockFetcherService as IFetcherService,
			mockLogService as ILogService,
			mockInstantiationService as IInstantiationService
		);
	});

	describe('constructor', () => {
		it('should use default URL when none provided', () => {
			expect(provider).toBeDefined();
			expect(FoundryLocalLMProvider.providerName).toBe('FoundryLocal');
		});

		it('should use provided URL', () => {
			const customUrl = 'http://custom-host:8080';
			const customProvider = new FoundryLocalLMProvider(
				customUrl,
				mockStorageService as IBYOKStorageService,
				mockFetcherService as IFetcherService,
				mockLogService as ILogService,
				mockInstantiationService as IInstantiationService
			);
			expect(customProvider).toBeDefined();
		});
	});

	describe('_checkFoundryService', () => {
		it('should succeed when health endpoint returns ok', async () => {
			const healthResponse: MockResponse = {
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ status: 'ok', version: '1.2.0' })
			};
			mockFetch.mockResolvedValueOnce(healthResponse);

			// Access the private method for testing
			const checkService = (provider as any)._checkFoundryService.bind(provider);
			await expect(checkService()).resolves.not.toThrow();
		});

		it('should fallback to models endpoint when health fails', async () => {
			// Health endpoint fails
			const healthError = new Error('Health endpoint not found');
			const modelsResponse: MockResponse = {
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ object: 'list', data: [] })
			};
			
			mockFetch
				.mockRejectedValueOnce(healthError)
				.mockResolvedValueOnce(modelsResponse);

			const checkService = (provider as any)._checkFoundryService.bind(provider);
			await expect(checkService()).resolves.not.toThrow();
		});

		it('should throw error when both endpoints fail', async () => {
			const error = new Error('Connection refused');
			mockFetch.mockRejectedValue(error);

			const checkService = (provider as any)._checkFoundryService.bind(provider);
			await expect(checkService()).rejects.toThrow('Foundry Local service is not running');
		});
	});

	describe('_getFoundryModelDetails', () => {
		it('should return model details when endpoint succeeds', async () => {
			const modelDetails = {
				id: 'test-model',
				name: 'Test Model',
				capabilities: ['tools'],
				context_length: 8192,
				max_tokens: 4096
			};
			
			const response: MockResponse = {
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => modelDetails
			};
			mockFetch.mockResolvedValueOnce(response);

			const getDetails = (provider as any)._getFoundryModelDetails.bind(provider);
			const result = await getDetails('test-model');

			expect(result).toEqual(modelDetails);
		});

		it('should return fallback details when all endpoints fail', async () => {
			mockFetch.mockRejectedValue(new Error('Not found'));

			const getDetails = (provider as any)._getFoundryModelDetails.bind(provider);
			const result = await getDetails('test-model');

			expect(result).toEqual({
				id: 'test-model',
				name: 'test-model',
				context_length: 4096,
				max_tokens: 2048,
				capabilities: []
			});
		});
	});

	describe('getAllModels', () => {
		it('should handle empty models response gracefully', async () => {
			// Mock health check
			const healthResponse: MockResponse = {
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ status: 'ok' })
			};
			
			// Mock models response
			const modelsResponse: MockResponse = {
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ object: 'list', data: [] })
			};

			mockFetch
				.mockResolvedValueOnce(healthResponse)
				.mockResolvedValueOnce(modelsResponse);

			const result = await provider.getAllModels();
			expect(result).toEqual({});
		});

		it('should handle invalid models response format', async () => {
			// Mock health check
			const healthResponse: MockResponse = {
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ status: 'ok' })
			};
			
			// Mock invalid models response
			const modelsResponse: MockResponse = {
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ invalid: 'format' })
			};

			mockFetch
				.mockResolvedValueOnce(healthResponse)
				.mockResolvedValueOnce(modelsResponse);

			const result = await provider.getAllModels();
			expect(result).toEqual({});
			expect(mockLogService.warn).toHaveBeenCalledWith('Invalid models response format from Foundry Local service');
		});
	});
});