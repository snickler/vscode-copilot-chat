/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Raw } from '@vscode/prompt-tsx';
import type { CancellationToken } from 'vscode';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IChatMLFetcher, IntentParams, Source } from '../../../platform/chat/common/chatMLFetcher';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, IResponseDelta, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { IFetcherService, Response } from '../../../platform/networking/common/fetcherService';
import { IEndpointBody } from '../../../platform/networking/common/networking';
import { ChatCompletion } from '../../../platform/networking/common/openai';
import { defaultChatResponseProcessor } from '../../../platform/endpoint/node/chatEndpoint';
import { ITelemetryService, TelemetryProperties } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { IThinkingDataService } from '../../../platform/thinking/node/thinkingDataService';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
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
			const transformedResponse = await this._transformFoundryLocalResponse(response);
			
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
	 * Transform Foundry Local response to remove duplicate message fields
	 */
	private async _transformFoundryLocalResponse(response: Response): Promise<Response> {
		try {
			this._logService.debug('[FoundryLocal] Starting stream transformation');
			
			// Get the response body text
			const originalText = await response.text();
			
			this._logService.debug(`[FoundryLocal] Original response length: ${originalText.length}`);
			
			// Transform the SSE stream
			const transformedText = this._transformSSEStream(originalText);
			
			this._logService.debug(`[FoundryLocal] Transformed response length: ${transformedText.length}`);
			
			// Create new response with transformed text
			return new Response(
				response.ok,
				response.status,
				response.statusText,
				response.headers,
				() => Promise.resolve(transformedText),
				() => Promise.resolve(JSON.parse(transformedText)),
				() => Promise.resolve(transformedText)
			);
		} catch (error) {
			this._logService.error(`[FoundryLocal] Error transforming response: ${error}`);
			// Return original response if transformation fails
			return response;
		}
	}

	/**
	 * Transform SSE stream to remove duplicate message fields
	 */
	private _transformSSEStream(text: string): string {
		const lines = text.split('\n');
		const transformedLines: string[] = [];

		for (const line of lines) {
			if (line.startsWith('data: ') && line !== 'data: [DONE]') {
				try {
					const dataContent = line.substring(6); // Remove 'data: '
					const data = JSON.parse(dataContent);
					
					if (data.choices && Array.isArray(data.choices)) {
						// Transform each choice to remove duplicate message fields
						data.choices = data.choices.map((choice: any) => {
							if (choice.delta && choice.message) {
								this._logService.debug(`[FoundryLocal] Removing duplicate message field from choice ${choice.index}`);
								// Keep delta, remove message
								const { message, ...choiceWithoutMessage } = choice;
								return choiceWithoutMessage;
							}
							return choice;
						});
					}
					
					transformedLines.push(`data: ${JSON.stringify(data)}`);
				} catch (error) {
					this._logService.debug(`[FoundryLocal] Could not parse line as JSON, passing through: ${line}`);
					transformedLines.push(line);
				}
			} else {
				transformedLines.push(line);
			}
		}

		return transformedLines.join('\n');
	}

	/**
	 * Check if this endpoint is a Foundry Local endpoint
	 */
	private _isFoundryLocalEndpoint(): boolean {
		try {
			const url = this.urlOrRequestMetadata as string;
			const isFoundryLocal = !!(url && url.includes('localhost:5273'));
			this._logService.debug(`[FoundryLocal] Checking URL: ${url}, isFoundryLocal: ${isFoundryLocal}`);
			return isFoundryLocal;
		} catch (error) {
			this._logService.warn(`[FoundryLocal] Error checking URL: ${error}`);
			return false;
		}
	}
}