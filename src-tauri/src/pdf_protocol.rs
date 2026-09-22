use crate::pdf_session::{
    PdfOwner, PdfSessionError, PdfSessionManager, SessionId, ABSOLUTE_RANGE_LIMIT,
};
use tauri::http::{header, Method, Request, Response, StatusCode};

/// Admit before scheduling. Rejection evidence contains the exact atomic occupancy, not an I/O claim.
pub(crate) fn admit_range_io(
    gate: &crate::native_io::IoGate,
    sessions: &PdfSessionManager,
) -> Result<crate::native_io::IoPermit, Box<Response<Vec<u8>>>> {
    match gate.try_acquire() {
        Ok(permit) => Ok(permit),
        Err(occupancy) => {
            sessions.observe_outer_range_rejection(occupancy);
            Err(Box::new(cors_empty(StatusCode::SERVICE_UNAVAILABLE)))
        }
    }
}
pub const PDF_PROTOCOL_HOST: &str = "localhost";
pub const PDF_PROTOCOL_ALLOWED_ORIGIN: &str = "http://tauri.localhost";
const PDF_PROTOCOL_ALLOWED_REFERER_PREFIX: &str = "http://tauri.localhost/";

/// Handles an already-attributed custom-protocol request. The caller supplies the owner from a
/// trusted webview boundary; the opaque URI token is only a session selector.
pub fn handle_pdf_protocol_request(
    request: &Request<Vec<u8>>,
    owner: &PdfOwner,
    sessions: &PdfSessionManager,
) -> Response<Vec<u8>> {
    let Some((id, generation)) = parse_route(request) else {
        return empty(StatusCode::NOT_FOUND);
    };
    if !has_trusted_request_source(request) {
        return empty(StatusCode::FORBIDDEN);
    }

    let length = match sessions.session_length(owner, &id, generation) {
        Ok(length) => length,
        Err(error) => return session_error(error),
    };

    match *request.method() {
        Method::OPTIONS => Response::builder()
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
        Method::HEAD => document_response(StatusCode::OK, length, None, Vec::new()),
        Method::GET => {
            let ranges = request.headers().get_all(header::RANGE);
            if ranges.iter().next().is_none() {
                let Some(full_length) = bounded_full_length(length) else {
                    return cors_empty(StatusCode::PAYLOAD_TOO_LARGE);
                };
                let bytes =
                    match sessions.read_range_absolute(owner, &id, generation, 0, full_length) {
                        Ok(bytes) if bytes.len() == full_length as usize => bytes,
                        Ok(_) | Err(PdfSessionError::FileUnreadable) => {
                            return cors_empty(StatusCode::INTERNAL_SERVER_ERROR)
                        }
                        Err(error) => return session_error(error),
                    };
                return document_response(StatusCode::OK, length, None, bytes);
            }
            let Some(range) = (ranges.iter().count() == 1)
                .then(|| ranges.iter().next())
                .flatten()
                .and_then(|value| value.to_str().ok())
                .and_then(|value| parse_range(value, length))
            else {
                return range_not_satisfiable(length);
            };
            let bytes = match sessions.read_range_absolute(
                owner,
                &id,
                generation,
                range.start,
                range.length,
            ) {
                Ok(bytes) if bytes.len() == range.length as usize => bytes,
                Ok(_) | Err(PdfSessionError::FileUnreadable) => {
                    return cors_empty(StatusCode::INTERNAL_SERVER_ERROR)
                }
                Err(error) => return session_error(error),
            };
            document_response(
                StatusCode::PARTIAL_CONTENT,
                range.length as u64,
                Some((range.start, range.end, length)),
                bytes,
            )
        }
        _ => Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "HEAD, GET, OPTIONS")
            .header(
                header::ACCESS_CONTROL_ALLOW_ORIGIN,
                PDF_PROTOCOL_ALLOWED_ORIGIN,
            )
            .header(header::VARY, "Origin")
            .body(Vec::new())
            .expect("static protocol response"),
    }
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
