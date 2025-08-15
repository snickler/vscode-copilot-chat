# Foundry Local BYOK Provider

The Foundry Local provider enables integration with local Foundry services for BYOK (Bring Your Own Key) scenarios. This provider uses the official `foundry-local-sdk` to interact with Foundry Local services, ensuring compatibility and proper service management.

## Prerequisites

- Foundry Local must be installed and available in your system PATH
- For Node.js environments: The SDK can auto-discover running services
- For browser environments: You must specify the service URL

## Configuration

The provider can be configured through the VS Code setting:

```json
{
  "github.copilot.chat.byok.foundryLocalEndpoint": "http://localhost:5273"
}
```

If no endpoint is specified, the provider will use the SDK's auto-discovery feature (Node.js only).

## SDK Integration

This provider integrates with Foundry Local using the official `foundry-local-sdk` package:

### Automatic Service Management

The SDK handles:
- Service discovery and connectivity
- Model catalog management  
- Authentication with local services
- OpenAI-compatible endpoint exposure

### Model Operations

The provider supports:
- **Model Discovery**: Lists available models from the Foundry Local catalog
- **Model Information**: Retrieves detailed model metadata including capabilities
- **Model Management**: Leverages SDK for model loading and lifecycle management

## Usage Patterns

### Node.js Environment (Auto-discovery)
```typescript
// Uses FoundryLocalManager with auto-discovery
const provider = new FoundryLocalLMProvider(
  undefined, // Auto-discover service
  // ... other dependencies
);
```

### Browser Environment (Explicit URL)
```typescript
// Uses browser-compatible SDK with explicit service URL
const provider = new FoundryLocalLMProvider(
  "http://localhost:5273", // Explicit service URL
  // ... other dependencies
);
```

## Expected Service Capabilities

The Foundry Local service should provide:
- **Model Catalog**: Access to available AI models via SDK
- **Model Metadata**: Detailed information about model capabilities and specifications  
- **OpenAI-compatible API**: Inference endpoints that work with OpenAI client libraries
- **Service Management**: Proper lifecycle management through the SDK

### Model Capabilities

The provider detects and maps model capabilities:

- **Tool Calling**: Inferred from model information and metadata
- **Vision**: Detected based on model task type (multimodal, vision) or name patterns
- **Context Length**: Uses SDK-provided model specifications with conservative defaults
- **Model Aliases**: Supports human-readable model names through SDK aliases

## Installation and Setup

1. **Install Foundry Local**: Follow the Foundry Local installation guide
2. **Start Service**: Run `foundry local start` to start the service  
3. **Configure VS Code**: Set the endpoint URL if needed (optional for Node.js environments)
4. **Select Models**: Choose from available models in the Foundry Local catalog

## Error Handling

The provider provides clear error messages for common scenarios:

- **Service Connectivity**: Automatic detection of service availability through SDK
- **Model Discovery**: Graceful handling when models are not found in catalog
- **SDK Integration**: Proper error mapping from SDK exceptions to user-friendly messages

## Authentication

This provider uses `BYOKAuthType.None` since local Foundry services typically don't require API keys. The SDK handles any necessary authentication tokens automatically.

## Implementation Notes

- Uses the official `foundry-local-sdk` for all service interactions
- Extends `BaseOpenAICompatibleLMProvider` for consistent chat completion behavior  
- Supports both Node.js (auto-discovery) and browser (explicit URL) environments
- Caches model information for improved performance
- Follows established patterns from other BYOK providers in the codebase

## Troubleshooting

### Service Not Found
- Ensure Foundry Local is installed and in your PATH
- Try running `foundry local start` manually
- Check that the service is running on the expected port

### Models Not Available  
- Verify models are available in the catalog: `foundry model list`
- Check that models are downloaded and ready for use
- Ensure the SDK can access the model catalog

### Connectivity Issues
- For browser environments, ensure the correct service URL is configured
- Check firewall settings if using custom ports
- Verify the service is accessible from your environment