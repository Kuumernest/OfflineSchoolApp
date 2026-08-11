function success(res, data = null, message = "Success", statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

function error(res, message = "Error", statusCode = 500, details = null) {
  return res.status(statusCode).json({
    success: false,
    error: message,
    details,
  });
}

function paginated(res, data, page, limit, total) {
  return res.status(200).json({
    success: true,
    data,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
}

module.exports = { success, error, paginated };