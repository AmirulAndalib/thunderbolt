# Assist Embeddings

This module provides optimized text embedding functionality for the Mozilla Assistant using the Jina BERT model.

## Key Features

- Efficient text embedding generation using Candle ML
- Metal GPU acceleration on macOS
- Optimized batch processing of multiple texts
- Adaptive batch sizing based on text length
- Resource management to prevent GPU memory issues

## Performance Optimizations

The following optimizations have been implemented:

1. **Adaptive Batch Sizing**: Automatically adjusts batch size based on average text length to prevent memory issues with very long texts.

2. **Sequential Processing with Pauses**: Uses sequential processing with small pauses between operations to avoid GPU command buffer conflicts.

3. **Memory Management**: Implements explicit memory management to release GPU resources between operations.

4. **Special Case Handling**: Optimizes the single-text case for better performance.

## Benchmark Results

Performance benchmarks show the following approximate processing times:

- Single text: ~21ms
- Batch processing: ~28ms per text with optimal resource utilization

## Usage

### Single Text Embedding

```rust
let embedder = Embedder::new()?;
let text = "This is a sample text to embed.";
let embedding = get_embedding_with_embedder(&embedder, text)?;
```

### Multiple Text Embeddings

```rust
let embedder = Embedder::new()?;
let texts = vec![
    "First text to embed.".to_string(),
    "Second text to embed.".to_string(),
    // ...more texts
];
let embeddings = get_embeddings_with_embedder(&embedder, &texts)?;
```

## Integration with Tauri

The embeddings module is integrated with the Tauri application through commands:

- `init_embedder`: Initializes the embedder instance
- `get_embedding`: Generates an embedding for a single text
- `get_embeddings`: Generates embeddings for multiple texts in an optimized manner

## Features

- Generate embeddings for email messages in batches
- Store embeddings in the database for later retrieval
- Uses the Jina AI embedding model for high-quality text representations
- Generates UUIDs v7 for time-sorted unique identifiers

## Examples

### Generate Embeddings

The main example that processes email messages from the database:

```bash
# Make sure you're in the mozilla-assist root directory
cargo run --manifest-path=src-tauri/assist_embeddings/Cargo.toml --example generate_embeddings
```

This example will:
1. Test the embedding generation functionality with a sample text 
2. Connect to the local database at `src-tauri/data/local.db`
3. Process a single batch of messages (up to 10)
4. Process all remaining messages without embeddings

### Test Embeddings

A simple example that only tests the embedding generation:

```bash
cargo run --manifest-path=src-tauri/assist_embeddings/Cargo.toml --example test_embeddings
```

This example only tests the embedding functionality without requiring a database connection.

## Technical Details

The embedding model returns tensors with shape `[1, 768]`, but the `to_vec1()` method in Candle requires a 1-dimensional tensor. To solve this, we flatten the tensor before returning it from the embedding function, resulting in a shape of `[768]`.

## Structure

- `lib.rs`: Main library code with database operations
- `embedding.rs`: Embedding generation using Jina AI model
- `examples/`: Example applications demonstrating the functionality 