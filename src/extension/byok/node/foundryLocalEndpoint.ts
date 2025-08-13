/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { CancellationToken } from 'vscode';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback } from '../../../platform/networking/common/fetch';
import { IFetcherService, Response } from '../../../platform/networking/common/fetcherService';
import { ChatCompletion } from '../../../platform/networking/common/openai';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { IThinkingDataService } from '../../../platform/thinking/node/thinkingDataService';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { OpenAIEndpoint } from './openAIEndpoint';

/**
 * Custom endpoint for Foundry Local that handles the dual delta+message streaming format.
 * Foundry Local sends both 'delta' and 'message' fields in each chunk, but VS Code's
 * OpenAI streaming parser expects only 'delta'. This endpoint transforms the stream
 * to remove duplicate 'message' fields before processing.
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
	}

	/**
	 * Override the response processor to transform Foundry Local's dual delta+message format
	 */
	public override async processResponseFromChatEndpoint(
		telemetryService: ITelemetryService,
		logService: ILogService,
		response: Response,
		expectedNumChoices: number,
		finishCallback: FinishedCallback,
		telemetryData: TelemetryData,
		cancellationToken?: CancellationToken | undefined
	): Promise<AsyncIterableObject<ChatCompletion>> {
		// Only apply transformation for Foundry Local endpoints
		if (this._isFoundryLocalEndpoint()) {
			this._logService.info('[FoundryLocal] Applying streaming format transformation');
			try {
				const transformedResponse = await this._transformFoundryLocalStream(response);
				
				return super.processResponseFromChatEndpoint(
					telemetryService,
					logService,
					transformedResponse,
					expectedNumChoices,
					finishCallback,
					telemetryData,
					cancellationToken
				);
			} catch (error) {
				this._logService.error(`[FoundryLocal] Stream transformation failed: ${error}`);
				// Fall back to original response if transformation fails
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

	/**
	 * Check if this endpoint is a Foundry Local endpoint
	 */
	private _isFoundryLocalEndpoint(): boolean {
		try {
			const url = this.urlOrRequestMetadata as string;
			return url && url.includes('localhost:5273');
		} catch (error) {
			this._logService.debug(`[FoundryLocal] Error checking URL: ${error}`);
			return false;
		}
	}

	/**
	 * Transform Foundry Local's dual delta+message format to standard OpenAI streaming format.
	 * Removes the duplicate 'message' field while keeping 'delta' field.
	 */
	private async _transformFoundryLocalStream(response: Response): Promise<Response> {
		this._logService.info('[FoundryLocal] Starting stream transformation');
		
		try {
			const originalBody = await response.body() as NodeJS.ReadableStream;
			const { Readable } = await import('stream');
			
			// Create a simpler transform stream
			const transformedStream = new Readable({
				read() {
					// No-op, we'll push data as it comes
				}
			});

			let buffer = '';
			originalBody.setEncoding('utf8');
			
			originalBody.on('data', (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split('\n');
				
				// Keep the last incomplete line in buffer
				buffer = lines.pop() || '';
				
				for (const line of lines) {
					try {
						const processedLine = this._transformStreamLine(line);
						if (processedLine !== null) {
							transformedStream.push(processedLine + '\n');
						}
					} catch (error) {
						// If transformation fails for a line, pass it through unchanged
						this._logService.warn(`[FoundryLocal] Failed to transform line, passing through: ${error}`);
						transformedStream.push(line + '\n');
					}
				}
			});

			originalBody.on('end', () => {
				// Process any remaining buffer
				if (buffer.trim()) {
					try {
						const processedLine = this._transformStreamLine(buffer);
						if (processedLine !== null) {
							transformedStream.push(processedLine + '\n');
						}
					} catch (error) {
						this._logService.warn(`[FoundryLocal] Failed to transform final line, passing through: ${error}`);
						transformedStream.push(buffer + '\n');
					}
				}
				transformedStream.push(null); // Signal end of stream
				this._logService.info('[FoundryLocal] Stream transformation completed');
			});

			originalBody.on('error', (error) => {
				this._logService.error(`[FoundryLocal] Original stream error: ${error}`);
				transformedStream.destroy(error);
			});

			// Create a new response with the transformed stream
			return {
				...response,
				body: () => Promise.resolve(transformedStream),
				ok: response.ok,
				status: response.status,
				statusText: response.statusText,
				headers: response.headers
			} as Response;

		} catch (error) {
			this._logService.error(`[FoundryLocal] Failed to setup stream transformation: ${error}`);
			// Return original response if transformation fails
			return response;
		}
	}

	/**
	 * Transform a single line from the SSE stream
	 */
	private _transformStreamLine(line: string): string | null {
		const trimmedLine = line.trim();
		
		// Pass through non-data lines unchanged
		if (!trimmedLine.startsWith('data: ') || trimmedLine === 'data: [DONE]') {
			return trimmedLine;
		}

		// Extract the JSON part
		const jsonPart = trimmedLine.substring(6); // Remove 'data: ' prefix
		
		if (!jsonPart || jsonPart === '[DONE]') {
			return trimmedLine;
		}

		try {
			const data = JSON.parse(jsonPart);
			
			// Transform choices array if it exists
			if (data.choices && Array.isArray(data.choices)) {
				data.choices = data.choices.map((choice: any) => {
					if (choice.message && choice.delta) {
						// Remove the duplicate message field, keep only delta
						const { message, ...choiceWithoutMessage } = choice;
						return choiceWithoutMessage;
					}
					return choice;
				});
			}

			return `data: ${JSON.stringify(data)}`;
		} catch (error) {
			// Return original line if parsing fails to avoid breaking the stream
			this._logService.debug(`[FoundryLocal] Failed to parse streaming chunk, passing through: ${error}`);
			return trimmedLine;
		}
	}
}