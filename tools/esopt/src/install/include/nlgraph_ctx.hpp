#pragma once

#include <memory>
#include <vector>
#include <stdexcept>

#include "variable_expression.h"

struct ExpressionGraph;

// ==========================================
// ExpressionGraphContext - Thread-local context for building expressions
// ==========================================

struct MODEL_API ExpressionGraphContext
{
	static thread_local std::vector<std::shared_ptr<ExpressionGraph>> _graph_stack;
	std::shared_ptr<ExpressionGraph> _local_graph;

	ExpressionGraphContext();
	~ExpressionGraphContext();

	std::shared_ptr<ExpressionGraph> get_graph() { return _local_graph; }

	// RAII interface
	std::shared_ptr<ExpressionGraph> enter();
	void exit();

	// Static methods for accessing the current graph
	static std::shared_ptr<ExpressionGraph> current_graph_no_exception();
	static std::shared_ptr<ExpressionGraph> current_graph();
};

// Helper class for RAII-style context management
class MODEL_API ExpressionGraphContextGuard
{
public:
	ExpressionGraphContextGuard();
	~ExpressionGraphContextGuard();

	ExpressionGraphContextGuard(const ExpressionGraphContextGuard&) = delete;
	ExpressionGraphContextGuard& operator=(const ExpressionGraphContextGuard&) = delete;

	std::shared_ptr<ExpressionGraph> graph() { return _graph; }

private:
	std::shared_ptr<ExpressionGraph> _graph;
};
