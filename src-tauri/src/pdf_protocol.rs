use crate::pdf_session::{
    FileCompletion, PdfOwner, PdfSessionError, PdfSessionManager, SessionId, ABSOLUTE_RANGE_LIMIT,
};
use tauri::http::{header, Method, Request, Response, StatusCode};

pub const PDF_PROTOCOL_HOST: &str = "localhost";
pub const PDF_PROTOCOL_ALLOWED_ORIGIN: &str = "http://tauri.localhost";
const PDF_PROTOCOL_ALLOWED_REFERER_PREFIX: &str = "http://tauri.localhost/";
const MAX_PROTOCOL_URI_BYTES: usize = 128;
const MAX_PROTOCOL_HEADER_BYTES: usize = 8 * 1024;
const MAX_PROTOCOL_HEADERS: usize = 64;

/// Carries only a completed bounded body and fixed response metadata, never the raw request.
pub(crate) enum PdfProtocolReply {
    Immediate(Response<Vec<u8>>),
    Read {
        result: Result<Vec<u8>, PdfSessionError>,
        expected: u32,
        total: u64,
        range: Option<(u64, u64, u64)>,
    },
}
impl PdfProtocolReply {
    /// Invoke at actual UI handoff while the file completion lease remains owned.
    pub(crate) fn into_response(self, completion: &FileCompletion) -> Response<Vec<u8>> {
        match self {
            Self::Immediate(response) => response,
            Self::Read {
                result,
                expected,
                total,
                range,
            } => match completion.guard_result(result) {
                Ok(bytes) if bytes.len() == expected as usize => document_response(
                    if range.is_some() {
                        StatusCode::PARTIAL_CONTENT
                    } else {
                        StatusCode::OK
                    },
                    if range.is_some() {
                        u64::from(expected)
                    } else {
                        total
                    },
                    range,
                    bytes,
                ),
                Ok(_) => cors_empty(StatusCode::INTERNAL_SERVER_ERROR),
                Err(error) => session_error(error),
            },
        }
    }
}

enum PreparedRequest {
    Immediate(Response<Vec<u8>>),
    Read {
        id: SessionId,
        generation: u64,
        offset: u64,
        length: u32,
        total: u64,
        range: Option<(u64, u64, u64)>,
    },
}

/// Native attribution precedes this boundary. No worker is reserved for validation or cached metadata.
pub(crate) fn dispatch_pdf_protocol_request<F>(
    request: Request<Vec<u8>>,
    owner: PdfOwner,
    sessions: &PdfSessionManager,
    complete: F,
) where
    F: FnOnce(PdfProtocolReply, FileCompletion) + Send + 'static,
{
    let prepared = prepare_request(&request, &owner, sessions);
    drop(request); // SDK input is bounded; no raw headers/body captured by a queued Rust closure.
    match prepared {
        PreparedRequest::Immediate(response) => complete(
            PdfProtocolReply::Immediate(response),
            FileCompletion::empty(),
        ),
        PreparedRequest::Read {
            id,
            generation,
            offset,
            length,
            total,
            range,
        } => {
            sessions.enqueue_range_read(
                owner,
                id,
                generation,
                offset,
                length,
                move |result, completion| {
                    complete(
                        PdfProtocolReply::Read {
                            result,
                            expected: length,
                            total,
                            range,
                        },
                        completion,
                    );
                },
            );
        }
    }
}

fn prepare_request(
    request: &Request<Vec<u8>>,
    owner: &PdfOwner,
    sessions: &PdfSessionManager,
) -> PreparedRequest {
    let immediate = PreparedRequest::Immediate;
    let uri = request.uri();
    let uri_bytes = uri.scheme_str().map_or(0, |value| value.len() + 3)
        + uri.authority().map_or(0, |value| value.as_str().len())
        + uri.path_and_query().map_or(0, |value| value.as_str().len());
    if uri_bytes > MAX_PROTOCOL_URI_BYTES {
        return immediate(empty(StatusCode::NOT_FOUND));
    }
    let header_bytes = request
        .headers()
        .iter()
        .try_fold(0usize, |sum, (name, value)| {
            sum.checked_add(name.as_str().len())?
                .checked_add(value.as_bytes().len())
        });
    if request.headers().len() > MAX_PROTOCOL_HEADERS
        || header_bytes.map_or(true, |bytes| bytes > MAX_PROTOCOL_HEADER_BYTES)
    {
        return immediate(cors_empty(StatusCode::PAYLOAD_TOO_LARGE));
    }
    if matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) && !request.body().is_empty()
    {
        return immediate(cors_empty(StatusCode::PAYLOAD_TOO_LARGE));
    }
    let Some((id, generation)) = parse_route(request) else {
        return immediate(empty(StatusCode::NOT_FOUND));
    };
    if !has_trusted_request_source(request) {
        return immediate(empty(StatusCode::FORBIDDEN));
    }
    let total = match sessions.session_length(owner, &id, generation) {
        Ok(length) => length,
        Err(error) => return immediate(session_error(error)),
    };
    match *request.method() {
        Method::OPTIONS => immediate(
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header(
                    header::ACCESS_CONTROL_ALLOW_ORIGIN,
                    PDF_PROTOCOL_ALLOWED_ORIGIN,
                )
                .header(header::ACCESS_CONTROL_ALLOW_METHODS, "HEAD, GET, OPTIONS")
                .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
                .header(header::VARY, "Origin")
                .body(Vec::new())
                .expect("static protocol response"),
        ),
        Method::HEAD => immediate(document_response(StatusCode::OK, total, None, Vec::new())),
        Method::GET => {
            let ranges = request.headers().get_all(header::RANGE);
            if ranges.iter().next().is_none() {
                return match bounded_full_length(total) {
                    Some(length) => PreparedRequest::Read {
                        id,
                        generation,
                        offset: 0,
                        length,
                        total,
                        range: None,
                    },
                    None => immediate(cors_empty(StatusCode::PAYLOAD_TOO_LARGE)),
                };
            }
            let Some(range) = (ranges.iter().count() == 1)
                .then(|| ranges.iter().next())
                .flatten()
                .and_then(|value| value.to_str().ok())
                .and_then(|value| parse_range(value, total))
            else {
                return immediate(range_not_satisfiable(total));
            };
            PreparedRequest::Read {
                id,
                generation,
                offset: range.start,
                length: range.length,
                total,
                range: Some((range.start, range.end, total)),
            }
        }
        _ => immediate(
            Response::builder()
                .status(StatusCode::METHOD_NOT_ALLOWED)
                .header(header::ALLOW, "HEAD, GET, OPTIONS")
                .header(
                    header::ACCESS_CONTROL_ALLOW_ORIGIN,
                    PDF_PROTOCOL_ALLOWED_ORIGIN,
                )
                .header(header::VARY, "Origin")
                .body(Vec::new())
                .expect("static protocol response"),
        ),
    }
}

/// Synchronous test facade uses the SAME dispatcher and owns completion through receipt.
#[cfg(test)]
pub(crate) fn handle_pdf_protocol_request(
    request: &Request<Vec<u8>>,
    owner: &PdfOwner,
    sessions: &PdfSessionManager,
) -> Response<Vec<u8>> {
    let mut owned = Request::builder()
        .method(request.method().clone())
        .uri(request.uri().clone())
        .body(request.body().clone())
        .unwrap();
    *owned.headers_mut() = request.headers().clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    dispatch_pdf_protocol_request(owned, owner.clone(), sessions, move |reply, completion| {
        let response = reply.into_response(&completion);
        let _ = sender.send((response, completion));
    });
    let (response, completion) = receiver.recv().expect("protocol test completion missing");
    drop(completion);
    response
}

#[derive(Clone, Copy)]
struct ByteRange {
    start: u64,
    end: u64,
    length: u32,
}

fn parse_route(request: &Request<Vec<u8>>) -> Option<(SessionId, u64)> {
    if request.uri().host()? != PDF_PROTOCOL_HOST || request.uri().query().is_some() {
        return None;
    }
    let mut components = request.uri().path().split('/');
    if !components.next()?.is_empty() {
        return None;
    }
    let id = SessionId::from_opaque(components.next()?.to_owned()).ok()?;
    let generation = parse_decimal(components.next()?)?;
    if components.next().is_some() {
        return None;
    }
    Some((id, generation))
}

fn has_trusted_request_source(request: &Request<Vec<u8>>) -> bool {
    let mut origins = request.headers().get_all(header::ORIGIN).iter();
    if let Some(origin) = origins.next() {
        return origins.next().is_none()
            && origin.to_str().ok() == Some(PDF_PROTOCOL_ALLOWED_ORIGIN);
    }

    let mut referers = request.headers().get_all(header::REFERER).iter();
    let Some(referer) = referers.next() else {
        return false;
    };
    referers.next().is_none()
        && referer.to_str().ok().is_some_and(|value| {
            value == PDF_PROTOCOL_ALLOWED_ORIGIN
                || value.starts_with(PDF_PROTOCOL_ALLOWED_REFERER_PREFIX)
        })
}
fn bounded_full_length(total: u64) -> Option<u32> {
    (total <= u64::from(ABSOLUTE_RANGE_LIMIT))
        .then(|| u32::try_from(total).ok())
        .flatten()
}
fn parse_range(value: &str, total: u64) -> Option<ByteRange> {
    let value = value.strip_prefix("bytes=")?;
    if value.is_empty() || value.contains(',') {
        return None;
    }
    let (first, last) = value.split_once('-')?;
    if last.contains('-') {
        return None;
    }
    let (start, end) = if first.is_empty() {
        let suffix = parse_decimal(last)?;
        if suffix == 0 || total == 0 {
            return None;
        }
        (total.saturating_sub(suffix), total - 1)
    } else {
        let start = parse_decimal(first)?;
        if start >= total {
            return None;
        }
        let end = if last.is_empty() {
            total - 1
        } else {
            parse_decimal(last)?.min(total - 1)
        };
        if end < start {
            return None;
        }
        (start, end)
    };
    let length = end.checked_sub(start)?.checked_add(1)?;
    if length > u64::from(ABSOLUTE_RANGE_LIMIT) {
        return None;
    }
    Some(ByteRange {
        start,
        end,
        length: u32::try_from(length).ok()?,
    })
}

fn parse_decimal(value: &str) -> Option<u64> {
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}

fn document_response(
    status: StatusCode,
    content_length: u64,
    content_range: Option<(u64, u64, u64)>,
    body: Vec<u8>,
) -> Response<Vec<u8>> {
    let mut response = Response::builder()
        .status(status)
        .header(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            PDF_PROTOCOL_ALLOWED_ORIGIN,
        )
        .header(header::VARY, "Origin")
        .header(header::CONTENT_TYPE, "application/pdf")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Accept-Ranges, Content-Length, Content-Range",
        )
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header(header::CONTENT_LENGTH, content_length);
    if let Some((start, end, total)) = content_range {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }
    response.body(body).expect("static protocol response")
}

fn range_not_satisfiable(total: u64) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            PDF_PROTOCOL_ALLOWED_ORIGIN,
        )
        .header(header::VARY, "Origin")
        .header(header::CONTENT_RANGE, format!("bytes */{total}"))
        .body(Vec::new())
        .expect("static protocol response")
}

fn session_error(error: PdfSessionError) -> Response<Vec<u8>> {
    match error {
        PdfSessionError::SessionCapacity | PdfSessionError::RangeCapacity => {
            cors_empty(StatusCode::SERVICE_UNAVAILABLE)
        }
        PdfSessionError::FileUnreadable => cors_empty(StatusCode::INTERNAL_SERVER_ERROR),
        PdfSessionError::SessionNotFound
        | PdfSessionError::OwnerMismatch
        | PdfSessionError::GenerationMismatch
        | PdfSessionError::SessionClosing => cors_empty(StatusCode::NOT_FOUND),
        _ => cors_empty(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

fn cors_empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            PDF_PROTOCOL_ALLOWED_ORIGIN,
        )
        .header(header::VARY, "Origin")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .expect("static protocol response")
}
fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("static protocol response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_path::{DriveKind, FinalHandlePolicy, LocalPathPolicy, PathPolicyError};
    use crate::pdf_session::NORMAL_RANGE_LIMIT;
    use std::fs::File;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    struct Local;
    impl LocalPathPolicy for Local {
        fn classify(&self, _: &Path) -> Result<DriveKind, PathPolicyError> {
            Ok(DriveKind::Fixed)
        }
    }
    struct Final;
    impl FinalHandlePolicy for Final {
        fn classify_final(&self, _: &File) -> Result<DriveKind, PathPolicyError> {
            Ok(DriveKind::Fixed)
        }
    }

    fn owner() -> PdfOwner {
        PdfOwner {
            window_label: "reader".into(),
            generation: 1,
        }
    }

    fn opaque(id: &SessionId) -> String {
        let debug = format!("{id:?}");
        debug
            .strip_prefix("SessionId(\"")
            .and_then(|value| value.strip_suffix("\")"))
            .expect("session debug representation")
            .to_owned()
    }

    fn session() -> (PdfSessionManager, SessionId, u64, PathBuf, Vec<u8>) {
        let path =
            std::env::temp_dir().join(format!("modeleaf-protocol-{}.pdf", rand::random::<u64>()));
        let bytes = b"%PDF-0123456789".to_vec();
        File::create(&path).unwrap().write_all(&bytes).unwrap();
        let manager = PdfSessionManager::new();
        let metadata = manager
            .open_local(owner(), &path, &Local, &Final, |path| File::open(path))
            .unwrap();
        (
            manager,
            metadata.session_id,
            metadata.document_generation,
            path,
            bytes,
        )
    }

    fn request(
        method: Method,
        id: &SessionId,
        generation: u64,
        range: Option<&str>,
    ) -> Request<Vec<u8>> {
        let mut builder = Request::builder()
            .method(method)
            .uri(format!(
                "http://{PDF_PROTOCOL_HOST}/{}/{}",
                opaque(id),
                generation
            ))
            .header(header::ORIGIN, PDF_PROTOCOL_ALLOWED_ORIGIN);
        if let Some(range) = range {
            builder = builder.header(header::RANGE, range);
        }
        builder.body(Vec::new()).unwrap()
    }
    #[test]
    fn options_and_head_have_exact_metadata_headers() {
        let (manager, id, generation, path, bytes) = session();
        let options = handle_pdf_protocol_request(
            &request(Method::OPTIONS, &id, generation, None),
            &owner(),
            &manager,
        );
        assert_eq!(options.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            options.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
            "HEAD, GET, OPTIONS"
        );
        assert_eq!(
            options.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS],
            "Range"
        );
        assert_eq!(options.headers()[header::VARY], "Origin");
        let head = handle_pdf_protocol_request(
            &request(Method::HEAD, &id, generation, None),
            &owner(),
            &manager,
        );
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.body().is_empty());
        assert_eq!(
            head.headers()[header::CONTENT_LENGTH],
            bytes.len().to_string()
        );
        assert_eq!(head.headers()[header::CONTENT_TYPE], "application/pdf");
        assert_eq!(head.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(
            head.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS],
            "Accept-Ranges, Content-Length, Content-Range"
        );
        assert_eq!(head.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(head.headers()["X-Content-Type-Options"], "nosniff");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn packaged_referer_is_accepted_without_origin_and_other_sources_are_rejected() {
        let (manager, id, generation, path, _) = session();
        let mut packaged = request(Method::HEAD, &id, generation, None);
        packaged.headers_mut().remove(header::ORIGIN);
        packaged.headers_mut().insert(
            header::REFERER,
            "http://tauri.localhost/reader".parse().unwrap(),
        );
        assert_eq!(
            handle_pdf_protocol_request(&packaged, &owner(), &manager).status(),
            StatusCode::OK,
        );

        packaged.headers_mut().remove(header::REFERER);
        assert_eq!(
            handle_pdf_protocol_request(&packaged, &owner(), &manager).status(),
            StatusCode::FORBIDDEN,
        );
        packaged.headers_mut().insert(
            header::REFERER,
            "http://tauri.localhost.evil/".parse().unwrap(),
        );
        assert_eq!(
            handle_pdf_protocol_request(&packaged, &owner(), &manager).status(),
            StatusCode::FORBIDDEN,
        );
        packaged.headers_mut().insert(
            header::REFERER,
            "http://tauri.localhost/reader".parse().unwrap(),
        );
        packaged
            .headers_mut()
            .insert(header::ORIGIN, "https://evil.invalid".parse().unwrap());
        assert_eq!(
            handle_pdf_protocol_request(&packaged, &owner(), &manager).status(),
            StatusCode::FORBIDDEN,
        );
        packaged
            .headers_mut()
            .insert(header::ORIGIN, PDF_PROTOCOL_ALLOWED_ORIGIN.parse().unwrap());
        packaged
            .headers_mut()
            .append(header::ORIGIN, PDF_PROTOCOL_ALLOWED_ORIGIN.parse().unwrap());
        assert_eq!(
            handle_pdf_protocol_request(&packaged, &owner(), &manager).status(),
            StatusCode::FORBIDDEN,
        );
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn session_errors_have_bounded_non_oracular_statuses() {
        let closing = session_error(PdfSessionError::SessionClosing);
        assert_eq!(closing.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            closing.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            PDF_PROTOCOL_ALLOWED_ORIGIN
        );
        assert_eq!(
            session_error(PdfSessionError::SessionClosing).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            session_error(PdfSessionError::OwnerMismatch).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            session_error(PdfSessionError::RangeCapacity).status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            session_error(PdfSessionError::FileUnreadable).status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
    #[test]
    fn large_range_probe_reports_bounded_body_and_total_content_range() {
        let path = std::env::temp_dir().join(format!(
            "modeleaf-protocol-large-{}.pdf",
            rand::random::<u64>()
        ));
        let mut bytes = vec![0x5a; ABSOLUTE_RANGE_LIMIT as usize + 1];
        bytes[..9].copy_from_slice(b"%PDF-1.7\n");
        let eof = bytes.len() - 5;
        bytes[eof..].copy_from_slice(b"%%EOF");
        File::create(&path).unwrap().write_all(&bytes).unwrap();
        let manager = PdfSessionManager::new();
        let metadata = manager
            .open_local(owner(), &path, &Local, &Final, |path| File::open(path))
            .unwrap();
        let probe = request(
            Method::GET,
            &metadata.session_id,
            metadata.document_generation,
            Some("bytes=0-1048575"),
        );
        let response = handle_pdf_protocol_request(&probe, &owner(), &manager);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len(), NORMAL_RANGE_LIMIT as usize);
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            NORMAL_RANGE_LIMIT.to_string()
        );
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes 0-{}/{}", NORMAL_RANGE_LIMIT - 1, bytes.len())
        );
        let maximum = handle_pdf_protocol_request(
            &request(
                Method::GET,
                &metadata.session_id,
                metadata.document_generation,
                Some("bytes=0-4194303"),
            ),
            &owner(),
            &manager,
        );
        assert_eq!(maximum.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(maximum.body().len(), ABSOLUTE_RANGE_LIMIT as usize);
        let over_limit = handle_pdf_protocol_request(
            &request(
                Method::GET,
                &metadata.session_id,
                metadata.document_generation,
                Some("bytes=0-4194304"),
            ),
            &owner(),
            &manager,
        );
        assert_eq!(over_limit.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn small_bounded_full_get_is_byte_exact() {
        let (manager, id, generation, path, bytes) = session();

        let response = handle_pdf_protocol_request(
            &request(Method::GET, &id, generation, None),
            &owner(),
            &manager,
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), &bytes);
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            bytes.len().to_string()
        );
        assert!(response.headers().get(header::CONTENT_RANGE).is_none());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn get_single_range_forms_are_byte_exact_and_source_is_unchanged() {
        let (manager, id, generation, path, bytes) = session();
        for (range, expected) in [
            ("bytes=0-0", &bytes[0..1]),
            ("bytes=5-8", &bytes[5..9]),
            ("bytes=14-99", &bytes[14..]),
            ("bytes=-3", &bytes[12..]),
            ("bytes=11-", &bytes[11..]),
        ] {
            let response = handle_pdf_protocol_request(
                &request(Method::GET, &id, generation, Some(range)),
                &owner(),
                &manager,
            );
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{range}");
            assert_eq!(response.body(), expected, "{range}");
            assert_eq!(
                response.headers()[header::CONTENT_LENGTH],
                expected.len().to_string()
            );
            assert_eq!(
                response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
                PDF_PROTOCOL_ALLOWED_ORIGIN
            );
            assert_eq!(
                response.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS],
                "Accept-Ranges, Content-Length, Content-Range"
            );
        }
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejected_ranges_return_416_without_reading_or_changing_source() {
        let (manager, id, generation, path, bytes) = session();
        for range in [
            Some("bytes=0-0,2-3"),
            Some("bytes=4-3"),
            Some("bytes=18446744073709551616-"),
            Some("bytes=15-"),
            Some("bytes=-0"),
        ] {
            let response = handle_pdf_protocol_request(
                &request(Method::GET, &id, generation, range),
                &owner(),
                &manager,
            );
            assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
            assert_eq!(
                response.headers()[header::CONTENT_RANGE],
                format!("bytes */{}", bytes.len())
            );
            assert!(response.body().is_empty());
        }
        assert_eq!(
            parse_range("bytes=0-2097151", 3 * 1_048_576)
                .unwrap()
                .length,
            2 * 1_048_576,
        );
        assert!(parse_range("bytes=0-4194304", u64::from(ABSOLUTE_RANGE_LIMIT) + 1).is_none());
        assert_eq!(
            bounded_full_length(u64::from(ABSOLUTE_RANGE_LIMIT)),
            Some(ABSOLUTE_RANGE_LIMIT)
        );
        assert_eq!(
            bounded_full_length(u64::from(ABSOLUTE_RANGE_LIMIT) + 1),
            None
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn bounded_input_limits_reject_before_file_admission() {
        let (manager, id, generation, path, bytes) = session();
        let mut head = request(Method::HEAD, &id, generation, None);
        let base: usize = head
            .headers()
            .iter()
            .map(|(name, value)| name.as_str().len() + value.as_bytes().len())
            .sum();
        let padding = MAX_PROTOCOL_HEADER_BYTES - base - "x-padding".len();
        head.headers_mut()
            .insert("x-padding", "p".repeat(padding).parse().unwrap());
        assert_eq!(
            handle_pdf_protocol_request(&head, &owner(), &manager).status(),
            StatusCode::OK
        );
        head.headers_mut()
            .insert("x-padding", "p".repeat(padding + 1).parse().unwrap());
        assert_eq!(
            handle_pdf_protocol_request(&head, &owner(), &manager).status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let mut head = request(Method::HEAD, &id, generation, None);
        for index in 0..MAX_PROTOCOL_HEADERS - 1 {
            head.headers_mut().insert(
                format!("x-{index}").parse::<header::HeaderName>().unwrap(),
                "v".parse().unwrap(),
            );
        }
        assert_eq!(
            handle_pdf_protocol_request(&head, &owner(), &manager).status(),
            StatusCode::OK
        );
        head.headers_mut().insert("x-over", "v".parse().unwrap());
        assert_eq!(
            handle_pdf_protocol_request(&head, &owner(), &manager).status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let mut body = request(Method::GET, &id, generation, Some("bytes=0-0"));
        body.body_mut().push(1);
        assert_eq!(
            handle_pdf_protocol_request(&body, &owner(), &manager).status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let mut long = request(Method::HEAD, &id, generation, None);
        *long.uri_mut() = format!("http://localhost/{}/1", "a".repeat(MAX_PROTOCOL_URI_BYTES))
            .parse()
            .unwrap();
        assert_eq!(
            handle_pdf_protocol_request(&long, &owner(), &manager).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn only_a_full_session_wait_queue_returns_capacity_status() {
        use std::sync::mpsc;
        use std::time::Duration;
        let (manager, id, generation, path, bytes) = session();
        let (held_sender, held_receiver) = mpsc::sync_channel(1);
        manager.enqueue_range_read(
            owner(),
            id.clone(),
            generation,
            0,
            1,
            move |result, completion| {
                assert_eq!(completion.guard_result(result).unwrap(), b"%");
                held_sender.send(completion).unwrap();
            },
        );
        let held = held_receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        let (sender, receiver) = mpsc::sync_channel(16);
        for _ in 0..9 {
            let sender = sender.clone();
            dispatch_pdf_protocol_request(
                request(Method::GET, &id, generation, Some("bytes=0-0")),
                owner(),
                &manager,
                move |reply, completion| {
                    let response = reply.into_response(&completion);
                    let _ = sender.send((response, completion));
                },
            );
        }
        let (full, completion) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(full.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(full.body().is_empty());
        assert_eq!(full.headers()[header::CACHE_CONTROL], "no-store");
        drop(completion);
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        drop(held);
        for _ in 0..8 {
            let (response, completion) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.body(), b"%");
            drop(completion);
        }
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn saturated_file_workers_wait_without_blocking_metadata_or_masking_invalid_requests() {
        use std::sync::mpsc;
        use std::time::Duration;
        let (manager, id, generation, path, bytes) = session();
        let mut handles = vec![(id.clone(), generation)];
        for _ in 0..3 {
            let metadata = manager
                .open_local(owner(), &path, &Local, &Final, |path| File::open(path))
                .unwrap();
            handles.push((metadata.session_id, metadata.document_generation));
        }
        let mut held = Vec::new();
        for (session_id, document_generation) in handles {
            let (sender, receiver) = mpsc::sync_channel(1);
            manager.enqueue_range_read(
                owner(),
                session_id,
                document_generation,
                0,
                1,
                move |result, completion| {
                    assert_eq!(completion.guard_result(result).unwrap(), b"%");
                    sender.send(completion).unwrap();
                },
            );
            held.push(receiver.recv_timeout(Duration::from_secs(5)).unwrap());
        }
        let (read_sender, read_receiver) = mpsc::sync_channel(1);
        dispatch_pdf_protocol_request(
            request(Method::GET, &id, generation, Some("bytes=0-0")),
            owner(),
            &manager,
            move |reply, completion| {
                let response = reply.into_response(&completion);
                let _ = read_sender.send((response, completion));
            },
        );
        assert!(matches!(
            read_receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        let metadata_manager = manager.clone();
        let metadata_id = id.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        let metadata = std::thread::spawn(move || {
            let statuses = [
                handle_pdf_protocol_request(
                    &request(Method::HEAD, &metadata_id, generation, None),
                    &owner(),
                    &metadata_manager,
                )
                .status(),
                handle_pdf_protocol_request(
                    &request(Method::OPTIONS, &metadata_id, generation, None),
                    &owner(),
                    &metadata_manager,
                )
                .status(),
                handle_pdf_protocol_request(
                    &request(Method::GET, &metadata_id, generation, Some("bytes=5-4")),
                    &owner(),
                    &metadata_manager,
                )
                .status(),
                handle_pdf_protocol_request(
                    &request(Method::GET, &metadata_id, generation + 1, Some("bytes=0-0")),
                    &owner(),
                    &metadata_manager,
                )
                .status(),
            ];
            let _ = sender.send(statuses);
        });
        let early = receiver.recv_timeout(Duration::from_secs(2));
        drop(held);
        metadata.join().unwrap();
        assert_eq!(
            early.unwrap(),
            [
                StatusCode::OK,
                StatusCode::NO_CONTENT,
                StatusCode::RANGE_NOT_SATISFIABLE,
                StatusCode::NOT_FOUND
            ]
        );
        let (read, completion) = read_receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(read.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(read.body(), b"%");
        drop(completion);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn wrong_owner_and_stale_generation_are_non_oracular_not_found() {
        let (manager, id, generation, path, _) = session();
        let wrong = PdfOwner {
            window_label: "other".into(),
            generation: 1,
        };
        assert_eq!(
            handle_pdf_protocol_request(
                &request(Method::GET, &id, generation, Some("bytes=0-0")),
                &wrong,
                &manager
            )
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            handle_pdf_protocol_request(
                &request(Method::GET, &id, generation + 1, Some("bytes=0-0")),
                &owner(),
                &manager
            )
            .status(),
            StatusCode::NOT_FOUND
        );
        std::fs::remove_file(path).unwrap();
    }
}
