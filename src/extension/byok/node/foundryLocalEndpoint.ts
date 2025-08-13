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

		this._logService.info(`[FoundryLocal] Created FoundryLocalEndpoint with URL: ${_modelUrl}`);
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
		// Check if this is a Foundry Local endpoint
		if (this._isFoundryLocalEndpoint()) {
			this._logService.info('[FoundryLocal] Detected Foundry Local endpoint, applying stream transformation');

			try {
				// Transform the response to remove duplicate message fields
				const transformedResponse = await this._createTransformedResponse(response);

				// Call parent with transformed response
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
				// Fall back to original response
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
			const isFoundryLocal = !!(url && url.includes('localhost:5273'));
			this._logService.info(`[FoundryLocal] Checking URL: ${url}, isFoundryLocal: ${isFoundryLocal}`);
			return isFoundryLocal;
		} catch (error) {
			this._logService.warn(`[FoundryLocal] Error checking URL: ${error}`);
			return false;
		}
	}

	/**
	 * Create a transformed response that removes duplicate message fields
	 * Simplified approach: read the entire stream and do string transformations
	 */
	private async _createTransformedResponse(originalResponse: Response): Promise<Response> {
		this._logService.info('[FoundryLocal] Creating simplified transformed response');

		try {
			// Get the original response body
			const originalBody = await originalResponse.body();

			let transformedBodyString: string;

			if (typeof originalBody === 'string') {
				// If it's already a string, transform it directly
				transformedBodyString = this._transformResponseBody(originalBody);
			} else if (originalBody && typeof originalBody === 'object' && 'read' in originalBody) {
				// If it's a stream, read it all and transform
				const chunks: Buffer[] = [];
				for await (const chunk of originalBody as any) {
					chunks.push(chunk);
				}
				const bodyString = Buffer.concat(chunks).toString();
				transformedBodyString = this._transformResponseBody(bodyString);
			} else {
				this._logService.warn('[FoundryLocal] Unexpected body type, returning original');
				return originalResponse;
			}

			// Create a new response with the transformed body
			return this._createResponseWithBody(originalResponse, transformedBodyString);
		} catch (error) {
			this._logService.error(`[FoundryLocal] Error creating transformed response: ${error}`);
			throw error;
		}
	}

	/**
	 * Transform the response body string to remove duplicate message fields
	 */
	private _transformResponseBody(bodyString: string): string {
		this._logService.info('[FoundryLocal] Transforming response body');

		const lines = bodyString.split('\n');
		const transformedLines: string[] = [];

		for (const line of lines) {
			const transformedLine = this._transformLine(line);
			if (transformedLine !== null) {
				transformedLines.push(transformedLine);
			}
		}

		const result = transformedLines.join('\n');
		this._logService.info(`[FoundryLocal] Transformed ${lines.length} lines to ${transformedLines.length} lines`);
		return result;
	}

	/**
	 * Create a new Response object with the transformed body
	 */
	private _createResponseWithBody(originalResponse: Response, transformedBody: string): Response {
		// Create a mock response that mimics the original but with transformed body
		const mockResponse = {
			ok: originalResponse.ok,
			status: originalResponse.status,
			statusText: originalResponse.statusText,
			headers: originalResponse.headers,
			body: async () => transformedBody,
			json: async () => JSON.parse(transformedBody),
			text: async () => transformedBody
		};

		return mockResponse as Response;
	}

	/**
	 * Transform a single SSE line to remove duplicate message fields
	 */
	private _transformLine(line: string): string | null {
		const trimmedLine = line.trim();

		// Pass through non-data lines unchanged
		if (!trimmedLine.startsWith('data: ')) {
			return trimmedLine;
		}

		// Handle [DONE] marker
		if (trimmedLine === 'data: [DONE]') {
			this._logService.debug('[FoundryLocal] Found stream end marker');
			return trimmedLine;
		}

		// Extract JSON from data line
		const jsonPart = trimmedLine.substring(6); // Remove 'data: ' prefix

		if (!jsonPart || jsonPart === '[DONE]') {
			return trimmedLine;
		}

		try {
			const data = JSON.parse(jsonPart);

			// Transform choices if they exist
			if (data.choices && Array.isArray(data.choices)) {
				let hasTransformation = false;

				data.choices = data.choices.map((choice: any, index: number) => {
					// Check if this choice has both delta and message (Foundry Local format)
					if (choice.delta && choice.message) {
						this._logService.debug(`[FoundryLocal] Removing duplicate message field from choice ${index}`);
						const { message, ...choiceWithoutMessage } = choice;
						hasTransformation = true;
						return choiceWithoutMessage;
					}
					return choice;
				});

				if (hasTransformation) {
					this._logService.debug('[FoundryLocal] Applied transformation to remove duplicate message fields');
				}
			}

			return `data: ${JSON.stringify(data)}`;
		} catch (error) {
			this._logService.debug(`[FoundryLocal] Failed to parse line as JSON, passing through: ${error}`);
			// Return original line if parsing fails
			return trimmedLine;
		}
	}
}