/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { CancellationToken } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { defaultChatResponseProcessor } from '../../../platform/endpoint/node/chatEndpoint';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback } from '../../../platform/networking/common/fetch';
import { IFetcherService, Response } from '../../../platform/networking/common/fetcherService';
import { ChatCompletion } from '../../../platform/networking/common/openai';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { IThinkingDataService } from '../../../platform/thinking/node/thinkingDataService';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { OpenAIEndpoint } from './openAIEndpoint';

/**
 * Custom endpoint for Foundry Local that handles the dual delta+message streaming format.
 * Foundry Local sends both delta and message fields causing duplicate content processing.
 * This class intercepts the response stream to remove duplicate message fields.
 */
export class FoundryLocalEndpoint extends OpenAIEndpoint {
	constructor(
		_modelInfo: IChatModelInformation,
		_apiKey: string,
		_modelUrl: string,
		@IFetcherService fetcherService: IFetcherService,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IEnvService envService: IEnvService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThinkingDataService thinkingDataService: IThinkingDataService,
		@ILogService private _logService: ILogService
	) {
		super(
			_modelInfo,
			_apiKey,
			_modelUrl,
			fetcherService,
			domainService,
			capiClientService,
			envService,
			telemetryService,
			authService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			thinkingDataService
		);

		this._logService.info(`[FoundryLocal] Created FoundryLocalEndpoint with URL: ${_modelUrl}`);
	}

	/**
	 * Override processResponseFromChatEndpoint to transform Foundry Local's dual format response
	 */
	override async processResponseFromChatEndpoint(
		telemetryService: ITelemetryService,
		logService: ILogService,
		response: Response,
		expectedNumChoices: number,
		finishCallback: FinishedCallback,
		telemetryData: TelemetryData,
		cancellationToken?: CancellationToken | undefined
	): Promise<AsyncIterableObject<ChatCompletion>> {
		if (this._isFoundryLocalEndpoint()) {
			this._logService.info('[FoundryLocal] Processing response with Foundry Local format transformation');

			// Transform the response to remove duplicate message fields
			const transformedResponse = await this._createTransformedResponse(response);

			// Use the default processor with the transformed response
			return defaultChatResponseProcessor(
				telemetryService,
				logService,
				transformedResponse,
				expectedNumChoices,
				finishCallback,
				telemetryData,
				cancellationToken
			);
		} else {
			// For non-Foundry Local endpoints, use standard processing
			return super.processResponseFromChatEndpoint(
				telemetryService,
				logService,
				response,
				expectedNumChoices,
				finishCallback,
				telemetryData,
				cancellationToken
			);
		}
	}

	/**
	 * Create a transformed response by reading the stream and transforming it
	 */
	private async _createTransformedResponse(response: Response): Promise<Response> {
		try {
			this._logService.info('[FoundryLocal] Creating transformed response');

			// Get the original body stream and read it completely
			const originalBody = await response.body() as any; // Use any to avoid NodeJS type issues
			const transformedText = await this._readAndTransformStream(originalBody);

			this._logService.info(`[FoundryLocal] Transformed response length: ${transformedText.length}`);

			// Create a simple readable stream from the transformed text
			const transformedStream = this._createReadableStreamFromText(transformedText);

			// Create a new Response with the transformed stream
			return new Response(
				response.status,
				response.statusText,
				response.headers,
				// text() method
				async () => transformedText,
				// json() method - for SSE, this usually isn't used but we'll provide it
				async () => {
					throw new Error('JSON parsing not supported for SSE streams');
				},
				// body() method - return the stream for SSE processing
				async () => transformedStream
			);
		} catch (error) {
			this._logService.error(`[FoundryLocal] Error creating transformed response: ${error}`);
			// Return original response on error
			return response;
		}
	}

	/**
	 * Read the original stream and transform it
	 */
	private async _readAndTransformStream(stream: any): Promise<string> {
		return new Promise((resolve, reject) => {
			let data = '';
			
			stream.on('data', (chunk: string) => {
				data += chunk;
			});

			stream.on('end', () => {
				try {
					const transformedData = this._transformSSEData(data);
					resolve(transformedData);
				} catch (error) {
					this._logService.error(`[FoundryLocal] Error transforming stream data: ${error}`);
					// On transformation error, return original data
					resolve(data);
				}
			});

			stream.on('error', (error: Error) => {
				this._logService.error(`[FoundryLocal] Error reading stream: ${error}`);
				reject(error);
			});
		});
	}

	/**
	 * Create a readable stream from text that mimics the original stream interface
	 */
	private _createReadableStreamFromText(text: string): any {
		const chunks = text.split('\n').map(line => line + '\n');
		let index = 0;
		let dataCallback: Function | undefined;
		let endCallbacks: Function[] = [];
		let errorCallback: Function | undefined;

		// Start emitting chunks immediately
		Promise.resolve().then(async () => {
			try {
				for (const chunk of chunks) {
					if (dataCallback) {
						dataCallback(chunk);
					}
					// Add a small delay to simulate async streaming
					await new Promise(resolve => setTimeout(resolve, 0));
				}
				// Emit end event after all chunks
				endCallbacks.forEach(cb => cb());
			} catch (error) {
				if (errorCallback) {
					errorCallback(error);
				}
			}
		});

		const stream = {
			on: (event: string, callback: (...args: any[]) => void) => {
				if (event === 'data') {
					dataCallback = callback;
				} else if (event === 'end') {
					endCallbacks.push(callback);
				} else if (event === 'error') {
					errorCallback = callback;
				}
			},
			setEncoding: (encoding: string) => {
				// No-op for our implementation
			}
		};

		return stream;
	}

	/**
	 * Transform SSE data to remove duplicate message fields
	 */
	private _transformSSEData(data: string): string {
		try {
			const lines = data.split('\n');
			const transformedLines: string[] = [];

			for (const line of lines) {
				if (line.startsWith('data: ') && line !== 'data: [DONE]') {
					try {
						const dataContent = line.substring(6); // Remove 'data: '
						const parsed = JSON.parse(dataContent);

						if (parsed.choices && Array.isArray(parsed.choices)) {
							// Transform each choice to remove duplicate message fields
							parsed.choices = parsed.choices.map((choice: any) => {
								if (choice.delta && choice.message) {
									this._logService.info(`[FoundryLocal] Removing duplicate message field from choice ${choice.index}`);
									// Keep delta, remove message
									const { message, ...choiceWithoutMessage } = choice;
									return choiceWithoutMessage;
								}
								return choice;
							});
						}

						transformedLines.push(`data: ${JSON.stringify(parsed)}`);
					} catch (parseError) {
						// If we can't parse as JSON, pass through unchanged
						this._logService.warn(`[FoundryLocal] Could not parse line as JSON, passing through: ${line}`);
						transformedLines.push(line);
					}
				} else {
					// Pass through non-data lines unchanged
					transformedLines.push(line);
				}
			}

			return transformedLines.join('\n');
		} catch (error) {
			this._logService.error(`[FoundryLocal] Error transforming SSE data: ${error}`);
			// Return original data on error
			return data;
		}
	}

	/**
	 * Check if this endpoint is a Foundry Local endpoint
	 */
	private _isFoundryLocalEndpoint(): boolean {
		try {
			const url = this.urlOrRequestMetadata as string;
			const isFoundryLocal = !!(url && url.includes('localhost:5273'));
			this._logService.info(`[FoundryLocal] Checking URL: ${url}, isFoundryLocal: ${isFoundryLocal}`);
			return isFoundryLocal;
		} catch (error) {
			this._logService.warn(`[FoundryLocal] Error checking URL: ${error}`);
			return false;
		}
	}
}